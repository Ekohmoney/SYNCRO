use super::*;
use soroban_sdk::{testutils::{Address as _, Ledger}, Address, Env, String};

fn setup() -> (Env, SubscriptionLoggingContractClient<'static>, Address) {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(SubscriptionLoggingContract, ());
    let client = SubscriptionLoggingContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    client.init(&admin);

    (env, client, admin)
}

#[test]
fn test_append_log_entry() {
    let (env, client, admin) = setup();

    let sub_id = 42;
    let action = String::from_str(&env, "Created");
    let details = String::from_str(&env, "User signed up");

    env.ledger().with_mut(|li| {
        li.timestamp = 1000;
    });

    client.append_log_entry(&sub_id, &action, &details);

    let logs = client.get_logs_for_subscription(&sub_id);
    assert_eq!(logs.len(), 1);
    
    let log = logs.get(0).unwrap();
    assert_eq!(log.timestamp, 1000);
    assert_eq!(log.action, action);
    assert_eq!(log.details, details);
}

#[test]
fn test_get_logs_for_subscription() {
    let (env, client, admin) = setup();

    let sub_id = 99;
    
    // Initial should be empty
    assert_eq!(client.get_logs_for_subscription(&sub_id).len(), 0);

    client.append_log_entry(
        &sub_id, 
        &String::from_str(&env, "Renewed"), 
        &String::from_str(&env, "Success")
    );
    client.append_log_entry(
        &sub_id, 
        &String::from_str(&env, "Failed"), 
        &String::from_str(&env, "Card declined")
    );

    let logs = client.get_logs_for_subscription(&sub_id);
    assert_eq!(logs.len(), 2);
    assert_eq!(logs.get(0).unwrap().action, String::from_str(&env, "Renewed"));
    assert_eq!(logs.get(1).unwrap().action, String::from_str(&env, "Failed"));
}

#[test]
#[should_panic(expected = "Error(Auth, InvalidAction)")]
fn test_log_unauthorized_access() {
    let (env, client, admin) = setup();

    let sub_id = 77;
    let action = String::from_str(&env, "Hacked");
    let details = String::from_str(&env, "Attacker");

    // Clear mock auths so the transaction fails authorization
    env.set_auths(&[]);
    
    // Should panic because the admin is not signing
    client.append_log_entry(&sub_id, &action, &details);
}
