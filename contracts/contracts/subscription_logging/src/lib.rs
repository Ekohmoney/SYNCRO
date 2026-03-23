#![no_std]
use soroban_sdk::{contract, contractevent, contractimpl, contracttype, vec, Address, Env, String, Vec};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LogEntry {
    pub timestamp: u64,
    pub action: String,
    pub details: String,
}

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Admin,
    SubscriptionLogs(u64), // sub_id
}

#[contractevent]
pub struct LogAppended {
    pub sub_id: u64,
    pub action: String,
}

#[contract]
pub struct SubscriptionLoggingContract;

#[contractimpl]
impl SubscriptionLoggingContract {
    pub fn init(env: Env, admin: Address) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("Already initialized");
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
    }

    fn require_admin(env: &Env) {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();
    }

    pub fn append_log_entry(
        env: Env,
        sub_id: u64,
        action: String,
        details: String,
    ) {
        Self::require_admin(&env);

        let mut logs: Vec<LogEntry> = env
            .storage()
            .persistent()
            .get(&DataKey::SubscriptionLogs(sub_id))
            .unwrap_or(vec![&env]);

        logs.push_back(LogEntry {
            timestamp: env.ledger().timestamp(),
            action: action.clone(),
            details,
        });

        env.storage()
            .persistent()
            .set(&DataKey::SubscriptionLogs(sub_id), &logs);

        LogAppended { sub_id, action }.publish(&env);
    }

    pub fn get_logs_for_subscription(env: Env, sub_id: u64) -> Vec<LogEntry> {
        env.storage()
            .persistent()
            .get(&DataKey::SubscriptionLogs(sub_id))
            .unwrap_or(vec![&env])
    }
}

#[cfg(test)]
mod test;
