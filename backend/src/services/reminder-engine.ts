import logger from '../config/logger';
import { supabase } from '../config/database';
import { emailService } from './email-service';
import { pushService, PushSubscription } from './push-service';
import { blockchainService } from './blockchain-service';
import {
  ReminderSchedule,
  Subscription,
  UserProfile,
  NotificationPayload,
  NotificationDelivery,
} from '../types/reminder';
import { calculateBackoffDelay } from '../utils/retry';
import { userPreferenceService } from './user-preference-service';

export interface ReminderEngineOptions {
  defaultDaysBefore?: number[];
  maxRetryAttempts?: number;
}

export class ReminderEngine {
  private defaultDaysBefore: number[];
  private maxRetryAttempts: number;

  constructor(options: ReminderEngineOptions = {}) {
    this.defaultDaysBefore = options.defaultDaysBefore || [7, 3, 1];
    this.maxRetryAttempts = options.maxRetryAttempts || 3;
  }

  /**
   * Process pending reminders for a given date
   */
  async processReminders(targetDate: Date = new Date()): Promise<void> {
    const dateString = targetDate.toISOString().split('T')[0];

    logger.info(`Processing reminders for date: ${dateString}`);

    try {
      const { data: reminders, error } = await supabase
        .from('reminder_schedules')
        .select('*')
        .eq('reminder_date', dateString)
        .eq('status', 'pending');

      if (error) {
        logger.error('Failed to fetch reminders:', error);
        throw error;
      }

      if (!reminders || reminders.length === 0) {
        logger.info(`No pending reminders found for ${dateString}`);
        return;
      }

      logger.info(`Found ${reminders.length} reminders to process`);

      for (const reminder of reminders) {
        try {
          await this.processReminder(reminder);
        } catch (error) {
          logger.error(`Failed to process reminder ${reminder.id}:`, error);
        }
      }
    } catch (error) {
      logger.error('Error processing reminders:', error);
      throw error;
    }
  }

  /**
   * Process a single reminder
   */
  private async processReminder(reminder: ReminderSchedule): Promise<void> {
    logger.info(`Processing reminder ${reminder.id} for subscription ${reminder.subscription_id}`);

    try {
      const subscription = await this.getSubscription(reminder.subscription_id);
      if (!subscription) {
        logger.warn(`Subscription ${reminder.subscription_id} not found`);
        await this.markReminderAsFailed(reminder.id, 'Subscription not found');
        return;
      }

      const userProfile = await this.getUserProfile(reminder.user_id);
      if (!userProfile) {
        logger.warn(`User profile ${reminder.user_id} not found`);
        await this.markReminderAsFailed(reminder.id, 'User profile not found');
        return;
      }

      const renewalDate = subscription.active_until || new Date().toISOString();
      const payload: NotificationPayload = {
        title: `${subscription.name} Renewal Reminder`,
        body: `${subscription.name} will renew in ${reminder.days_before} day${reminder.days_before > 1 ? 's' : ''}`,
        subscription,
        reminderType: reminder.reminder_type,
        daysBefore: reminder.days_before,
        renewalDate,
      };

      const preferences = await userPreferenceService.getPreferences(reminder.user_id);
      const deliveryChannels = preferences.notification_channels;

      const deliveries: NotificationDelivery[] = [];

      // Email delivery
      if (deliveryChannels.includes('email') && preferences.email_opt_ins.reminders) {
        const emailDelivery = await this.createDeliveryRecord(
          reminder.id,
          reminder.user_id,
          'email',
        );
        deliveries.push(emailDelivery);

        const emailResult = await emailService.sendReminderEmail(
          userProfile.email,
          payload,
          { maxAttempts: this.maxRetryAttempts },
        );

        await this.updateDeliveryRecord(
          emailDelivery.id,
          emailResult.success ? 'sent' : 'failed',
          emailResult.error,
          emailResult.metadata,
        );
      }

      // Push delivery — now uses real subscription data
      if (deliveryChannels.includes('push')) {
        const pushSubscription = await this.getPushSubscription(reminder.user_id);
        if (pushSubscription) {
          const pushDelivery = await this.createDeliveryRecord(
            reminder.id,
            reminder.user_id,
            'push',
          );
          deliveries.push(pushDelivery);

          const pushResult = await pushService.sendPushNotification(
            pushSubscription,
            payload,
            { maxAttempts: this.maxRetryAttempts },
          );

          await this.updateDeliveryRecord(
            pushDelivery.id,
            pushResult.success ? 'sent' : 'failed',
            pushResult.error,
            pushResult.metadata,
          );

          // If the push subscription is gone (410/404), clean it up
          if (
            !pushResult.success &&
            pushResult.metadata?.retryable === false
          ) {
            await this.removeStalePushSubscription(reminder.user_id);
          }
        } else {
          logger.debug(
            `No push subscription found for user ${reminder.user_id}, skipping push delivery`,
          );
        }
      }

      await blockchainService.logReminderEvent(
        reminder.user_id,
        payload,
        deliveryChannels,
      );

      const hasSuccess = deliveries.some(
        (d) => d.status === 'sent' || d.status === 'retrying',
      );

      await supabase
        .from('reminder_schedules')
        .update({
          status: hasSuccess ? 'sent' : 'failed',
          updated_at: new Date().toISOString(),
        })
        .eq('id', reminder.id);

      logger.info(`Reminder ${reminder.id} processed successfully`);
    } catch (error) {
      logger.error(`Error processing reminder ${reminder.id}:`, error);
      await this.markReminderAsFailed(reminder.id, String(error));
      throw error;
    }
  }

  /**
   * Process failed deliveries that need retry
   */
  async processRetries(): Promise<void> {
    const now = new Date().toISOString();

    logger.info('Processing delivery retries');

    try {
      const { data: deliveries, error } = await supabase
        .from('notification_deliveries')
        .select('*, reminder_schedules!inner(*)')
        .eq('status', 'retrying')
        .lte('next_retry_at', now)
        .lt('attempt_count', this.maxRetryAttempts);

      if (error) {
        logger.error('Failed to fetch retry deliveries:', error);
        throw error;
      }

      if (!deliveries || deliveries.length === 0) {
        logger.info('No deliveries need retry');
        return;
      }

      logger.info(`Found ${deliveries.length} deliveries to retry`);

      for (const delivery of deliveries) {
        try {
          await this.retryDelivery(
            delivery as NotificationDelivery & { reminder_schedules: ReminderSchedule },
          );
        } catch (error) {
          logger.error(`Failed to retry delivery ${delivery.id}:`, error);
        }
      }
    } catch (error) {
      logger.error('Error processing retries:', error);
      throw error;
    }
  }

  /**
   * Retry a failed delivery
   */
  private async retryDelivery(
    delivery: NotificationDelivery & { reminder_schedules: ReminderSchedule },
  ): Promise<void> {
    const reminder = delivery.reminder_schedules;
    const newAttemptCount = delivery.attempt_count + 1;

    logger.info(
      `Retrying delivery ${delivery.id} (attempt ${newAttemptCount}/${this.maxRetryAttempts})`,
    );

    try {
      const subscription = await this.getSubscription(reminder.subscription_id);
      const userProfile = await this.getUserProfile(delivery.user_id);

      if (!subscription || !userProfile) {
        await this.markDeliveryAsFailed(delivery.id, 'Subscription or user not found');
        return;
      }

      const renewalDate = subscription.active_until || new Date().toISOString();
      const payload: NotificationPayload = {
        title: `${subscription.name} Renewal Reminder`,
        body: `${subscription.name} will renew in ${reminder.days_before} day${reminder.days_before > 1 ? 's' : ''}`,
        subscription,
        reminderType: reminder.reminder_type,
        daysBefore: reminder.days_before,
        renewalDate,
      };

      let result: { success: boolean; error?: string; metadata?: Record<string, any> };

      if (delivery.channel === 'email') {
        result = await emailService.sendReminderEmail(userProfile.email, payload, {
          maxAttempts: 1,
        });
      } else if (delivery.channel === 'push') {
        const pushSubscription = await this.getPushSubscription(delivery.user_id);
        if (!pushSubscription) {
          await this.markDeliveryAsFailed(delivery.id, 'Push subscription not found');
          return;
        }
        result = await pushService.sendPushNotification(pushSubscription, payload, {
          maxAttempts: 1,
        });

        // Clean up stale subscription on permanent failure
        if (!result.success && result.metadata?.retryable === false) {
          await this.removeStalePushSubscription(delivery.user_id);
        }
      } else {
        await this.markDeliveryAsFailed(delivery.id, `Unknown channel: ${delivery.channel}`);
        return;
      }

      if (result.success) {
        await supabase
          .from('notification_deliveries')
          .update({
            status: 'sent',
            attempt_count: newAttemptCount,
            last_attempt_at: new Date().toISOString(),
            next_retry_at: null,
            error_message: null,
            updated_at: new Date().toISOString(),
          })
          .eq('id', delivery.id);
      } else {
        const delay = calculateBackoffDelay(newAttemptCount);
        const nextRetryAt = new Date(Date.now() + delay);

        if (newAttemptCount >= this.maxRetryAttempts) {
          await this.markDeliveryAsFailed(delivery.id, result.error || 'Max attempts reached');
        } else {
          await supabase
            .from('notification_deliveries')
            .update({
              status: 'retrying',
              attempt_count: newAttemptCount,
              last_attempt_at: new Date().toISOString(),
              next_retry_at: nextRetryAt.toISOString(),
              error_message: result.error || null,
              updated_at: new Date().toISOString(),
            })
            .eq('id', delivery.id);
        }
      }
    } catch (error) {
      logger.error(`Error retrying delivery ${delivery.id}:`, error);
      await this.markDeliveryAsFailed(delivery.id, String(error));
    }
  }

  /**
   * Schedule reminders for subscriptions with upcoming renewals
   */
  async scheduleReminders(daysBefore: number[] = this.defaultDaysBefore): Promise<void> {
    const startTime = Date.now();
    logger.info(`Scheduling reminders for days before: ${daysBefore.join(', ')}`);

    try {
      const { data: subscriptions, error } = await supabase
        .from('subscriptions')
        .select('*')
        .eq('status', 'active')
        .not('active_until', 'is', null)
        .gt('active_until', new Date().toISOString());

      if (error) {
        logger.error('Failed to fetch subscriptions:', error);
        throw error;
      }

      if (!subscriptions || subscriptions.length === 0) {
        logger.info('No active subscriptions with future renewal dates');
        return;
      }

      logger.info(`Found ${subscriptions.length} subscriptions to schedule reminders for`);

      // 1. Batch fetch user preferences
      const userIds = [...new Set(subscriptions.map((s) => s.user_id))];
      const { data: preferencesList, error: prefError } = await supabase
        .from('user_preferences')
        .select('*')
        .in('user_id', userIds);

      if (prefError) {
        logger.error('Failed to fetch user preferences:', prefError);
        throw prefError;
      }

      const preferencesMap = new Map<string, number[]>(
        (preferencesList || []).map((p) => [p.user_id, p.reminder_timing])
      );

      // 2. Prepare records
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const records: any[] = [];

      for (const subscription of subscriptions) {
        if (!subscription.active_until) continue;

        // Use user's preferred timing if available, otherwise use default
        const userDaysBefore = preferencesMap.get(subscription.user_id) || daysBefore;
        const renewalDate = new Date(subscription.active_until);

        for (const days of userDaysBefore) {
          const reminderDate = new Date(renewalDate);
          reminderDate.setDate(reminderDate.getDate() - days);
          reminderDate.setHours(0, 0, 0, 0);

          if (reminderDate >= today) {
            records.push({
              subscription_id: subscription.id,
              user_id: subscription.user_id,
              reminder_date: reminderDate.toISOString().split('T')[0],
              reminder_type: 'renewal',
              days_before: days,
              status: 'pending',
              updated_at: new Date().toISOString(),
            });
          }
        }
      }

      if (records.length === 0) {
        logger.info('No reminders need to be scheduled');
        return;
      }

      // 3. Batch upsert — Supabase supports up to 1000 rows per upsert
      const BATCH_SIZE = 500;
      let totalUpserted = 0;

      for (let i = 0; i < records.length; i += BATCH_SIZE) {
        const batch = records.slice(i, i + BATCH_SIZE);
        const { error: upsertError } = await supabase
          .from('reminder_schedules')
          .upsert(batch, { onConflict: 'subscription_id,reminder_date' });

        if (upsertError) {
          logger.error('Failed to batch upsert reminders:', upsertError);
          throw upsertError;
        }
        totalUpserted += batch.length;
      }

      const duration = Date.now() - startTime;
      logger.info(
        `Reminder scheduling completed in ${duration}ms. Total reminders processed: ${records.length}, Batched in ${Math.ceil(
          records.length / BATCH_SIZE,
        )} round trips.`,
      );
    } catch (error) {
      logger.error('Error scheduling reminders:', error);
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async getSubscription(id: string): Promise<Subscription | null> {
    const { data, error } = await supabase
      .from('subscriptions')
      .select('*')
      .eq('id', id)
      .single();

    if (error || !data) return null;
    return data as Subscription;
  }

  private async getUserProfile(userId: string): Promise<UserProfile | null> {
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .single();

    if (error || !data) return null;

    let email = data.email || '';
    try {
      const { data: authUser, error: authError } = await supabase.auth.admin.getUserById(userId);
      if (!authError && authUser?.user?.email) {
        email = authUser.user.email;
      }
    } catch (authErr) {
      logger.warn(`Could not fetch email from auth.users for user ${userId}:`, authErr);
    }

    if (!email) {
      const { data: emailAccount } = await supabase
        .from('email_accounts')
        .select('email')
        .eq('user_id', userId)
        .eq('is_connected', true)
        .limit(1)
        .single();

      if (emailAccount) {
        email = emailAccount.email;
      }
    }

    if (!email) {
      logger.error(`No email found for user ${userId}`);
      return null;
    }

    return {
      id: data.id,
      email,
      full_name: data.full_name || data.display_name || null,
      timezone: data.timezone || 'UTC',
      currency: data.currency || 'USD',
    };
  }

  /**
   * Fetch the most recently created push subscription for a user.
   * Returns null if the user has no active push subscription in the database.
   */
  private async getPushSubscription(userId: string): Promise<PushSubscription | null> {
    try {
      const { data, error } = await supabase
        .from('push_subscriptions')
        .select('endpoint, p256dh, auth')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      if (error) {
        // PGRST116 = no rows returned — user simply hasn't subscribed yet
        if (error.code === 'PGRST116') {
          return null;
        }
        logger.error(`Error fetching push subscription for user ${userId}:`, error);
        return null;
      }

      if (!data) return null;

      return {
        endpoint: data.endpoint,
        keys: {
          p256dh: data.p256dh,
          auth: data.auth,
        },
      };
    } catch (err) {
      logger.error(`Unexpected error fetching push subscription for user ${userId}:`, err);
      return null;
    }
  }

  /**
   * Remove all push subscriptions for a user when the browser reports
   * the subscription is gone (HTTP 410/404 from the push service).
   */
  private async removeStalePushSubscription(userId: string): Promise<void> {
    try {
      const { error } = await supabase
        .from('push_subscriptions')
        .delete()
        .eq('user_id', userId);

      if (error) {
        logger.warn(`Failed to remove stale push subscriptions for user ${userId}:`, error);
      } else {
        logger.info(`Removed stale push subscriptions for user ${userId}`);
      }
    } catch (err) {
      logger.warn(`Unexpected error removing stale push subscription for user ${userId}:`, err);
    }
  }

  private async createDeliveryRecord(
    reminderScheduleId: string,
    userId: string,
    channel: 'email' | 'push',
  ): Promise<NotificationDelivery> {
    const { data, error } = await supabase
      .from('notification_deliveries')
      .insert({
        reminder_schedule_id: reminderScheduleId,
        user_id: userId,
        channel,
        status: 'pending',
        attempt_count: 0,
        max_attempts: this.maxRetryAttempts,
      })
      .select()
      .single();

    if (error) throw error;
    return data as NotificationDelivery;
  }

  private async updateDeliveryRecord(
    deliveryId: string,
    status: 'sent' | 'failed' | 'retrying',
    errorMessage: string | undefined,
    metadata: Record<string, any> | undefined,
  ): Promise<void> {
    const updateData: any = {
      status,
      attempt_count: 1,
      last_attempt_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    if (errorMessage) {
      updateData.error_message = errorMessage;
    }

    if (metadata) {
      updateData.metadata = metadata;
    }

    if (status === 'retrying') {
      const delay = calculateBackoffDelay(1);
      updateData.next_retry_at = new Date(Date.now() + delay).toISOString();
    }

    const { error } = await supabase
      .from('notification_deliveries')
      .update(updateData)
      .eq('id', deliveryId);

    if (error) throw error;
  }

  private async markDeliveryAsFailed(
    deliveryId: string,
    errorMessage: string,
  ): Promise<void> {
    await supabase
      .from('notification_deliveries')
      .update({
        status: 'failed',
        error_message: errorMessage,
        updated_at: new Date().toISOString(),
      })
      .eq('id', deliveryId);
  }

  private async markReminderAsFailed(
    reminderId: string,
    errorMessage: string,
  ): Promise<void> {
    await supabase
      .from('reminder_schedules')
      .update({
        status: 'failed',
        updated_at: new Date().toISOString(),
      })
      .eq('id', reminderId);
  }
}

export const reminderEngine = new ReminderEngine();