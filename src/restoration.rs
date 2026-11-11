/*
 * This software is in the public domain under CC0 1.0 Universal plus a
 * Grant of Patent License.
 *
 * To the extent possible under law, the author(s) have dedicated all
 * copyright and related and neighboring rights to this software to the
 * public domain worldwide. This software is distributed without any
 * warranty.
 *
 * You should have received a copy of the CC0 Public Domain Dedication
 * along with this software (see the LICENSE.md file). If not, see
 * <http://creativecommons.org/publicdomain/zero/1.0/>.
 */

//! The restart of subscriptions and polling after a fault or a restart, independent of the driver that runs them.
//!
//! moqui.device.DeviceAcquisitionServices.start#Subscriptions, called by a ServiceJob, asks run#DeviceRequest for every
//! subscription and polling read of the controllers in the scope of this gateway (get#StartupSubscriptions, discovered
//! again on every call). The implementation of a request answers `unchanged` for one that is running, starts one that
//! is not (after a restart, or when its connection was lost), or fails. A failed start is tried again without limit,
//! each wait twice the previous one up to a maximum, and notified once after a number of failures in a row. A request
//! stopped with an explicit unsubscribe (record#SubscriptionState) is not started again until it is subscribed again.
//! The state is per process: each instance restores its own requests.

use moqui_core::{
    context::{Error as FactoryError, ExecutionContext, ExecutionContextFactory},
    native::{Parameters, ServiceInfo, Tool, ToolFactory},
    transaction::TransactionAttribute,
};
use moqui_lib::{
    error::Error,
    object::{to_plain_string, Value},
};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

/// The failed starts of a request since its last success, and when to try again.
#[derive(Default)]
struct Attempts {
    count: u64,
    next: Option<Instant>,
}

impl Attempts {
    fn ready(&self, now: Instant) -> bool {
        self.next.is_none_or(|next| next <= now)
    }

    /// One more failure: the next attempt waits `delay`, doubled after each failure up to `max_delay`.
    fn record(&mut self, delay: Duration, max_delay: Duration, now: Instant) {
        self.count += 1;
        let factor = 1u32 << (self.count - 1).min(20);
        self.next = Some(now + delay.saturating_mul(factor).min(max_delay));
    }
}

#[derive(Default)]
struct Restoration {
    /// The requests to keep running, as the last discovery found them, with their failed starts.
    requests: BTreeMap<String, Attempts>,
    /// Stopped by an explicit unsubscribe.
    stopped: BTreeSet<String>,
}

/// Tool `DeviceSubscriptions`: the restoration state of this process.
#[derive(Default)]
pub struct DeviceSubscriptionsFactory {
    state: Mutex<Restoration>,
    /// Held by the start#Subscriptions under way.
    running: Mutex<()>,
}

struct DeviceSubscriptionsTool;
impl Tool for DeviceSubscriptionsTool {}
impl ToolFactory for DeviceSubscriptionsFactory {
    fn name(&self) -> &str {
        "DeviceSubscriptions"
    }

    fn init(&self, _: &Arc<ExecutionContextFactory>) -> Result<(), FactoryError> {
        Ok(())
    }

    fn get_instance(&self, _: &[Value]) -> Result<Arc<dyn Tool>, FactoryError> {
        Ok(Arc::new(DeviceSubscriptionsTool))
    }
}

fn factory(ec: &ExecutionContext) -> Result<Arc<DeviceSubscriptionsFactory>, Error> {
    ec.factory()
        .get_tool_factory_typed::<DeviceSubscriptionsFactory>("DeviceSubscriptions")
        .ok_or_else(|| Error::new("The DeviceSubscriptions tool of moqui-device is not installed"))
}

fn text(params: &Parameters, key: &str) -> Option<String> {
    params
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(String::from)
}

fn integer(params: &Parameters, key: &str, default: u64, min: u64, max: u64) -> Result<u64, Error> {
    let n = match params.get(key) {
        None | Some(Value::Null) => default,
        Some(v) => to_plain_string(v)
            .parse()
            .map_err(|_| Error::new(format!("{key} must be an integer")))?,
    };
    if !(min..=max).contains(&n) {
        return Err(Error::new(format!("{key} must be {min}..{max}")));
    }
    Ok(n)
}

/// A service call in its own transaction; an error it records in the message facade is an error here.
fn isolated(ec: &ExecutionContext, service: &str, params: &Parameters) -> Result<Parameters, Error> {
    let mark = ec.message().error_mark();
    let ef = ec
        .factory()
        .entity()
        .ok_or_else(|| Error::new("Entity Engine is not installed"))?;
    let out = ef
        .transactions_for("moqui.device.DeviceRequest")?
        .run(TransactionAttribute::IgnoreSuspend, None, || {
            moqui_core::service::sync(service, params).map_err(|e| Error::new(e.to_string()))
        });
    let errors = ec.message().take_errors_since(mark);
    if errors.is_empty() {
        out
    } else {
        Err(Error::new(errors.join("; ")))
    }
}

fn list(values: impl IntoIterator<Item = String>) -> Value {
    Value::List(values.into_iter().map(Value::string).collect())
}

/// moqui.device.DeviceAcquisitionServices.record#SubscriptionState, called by run#DeviceRequest after a subscription,
/// polling or unsubscribe request: an explicit unsubscribe stops the restoration of its parent, an active
/// subscription or polling resumes it.
pub fn record(ec: &ExecutionContext, _: &ServiceInfo<'_>, params: &Parameters) -> Result<Parameters, Error> {
    let name = text(params, "requestName").ok_or_else(|| Error::new("requestName is required"))?;
    let status = text(params, "status").unwrap_or_default();
    let factory = factory(ec)?;
    let mut state = factory
        .state
        .lock()
        .map_err(|_| Error::new("Subscription state lock poisoned"))?;
    match text(params, "requestTypeEnumId").as_deref() {
        Some("DrtUnsubscribe") if status == "completed" => {
            if let Some(parent) = text(params, "parentRequestName") {
                state.requests.remove(&parent);
                state.stopped.insert(parent);
            }
        }
        // A DrtRead is active only while it polls: a single read completes.
        Some("DrtSubscribe" | "DrtEvent" | "DrtStateChange" | "DrtCyclic" | "DrtRead")
            if matches!(status.as_str(), "active" | "unchanged") =>
        {
            state.stopped.remove(&name);
            if let Some(attempts) = state.requests.get_mut(&name) {
                *attempts = Attempts::default();
            }
        }
        _ => {}
    }
    Ok(Parameters::new())
}

/// moqui.device.DeviceAcquisitionServices.start#Subscriptions.
pub fn start(ec: &ExecutionContext, _: &ServiceInfo<'_>, params: &Parameters) -> Result<Parameters, Error> {
    let notify_after = integer(params, "notifyAfterAttempts", 3, 1, 1000)?;
    let delay = Duration::from_millis(integer(params, "retryDelayMillis", 60_000, 0, 86_400_000)?);
    let max_delay = Duration::from_millis(integer(params, "maxRetryDelayMillis", 900_000, 0, 86_400_000)?).max(delay);
    let mut started = Vec::new();
    let mut failed = Vec::new();
    let mut out = Parameters::new();
    if moqui_lib::env::get_prop_or_env("device_gateway_restore_subscriptions") == "false" {
        out.insert("startedRequestNames".into(), list(started));
        out.insert("failedRequestNames".into(), list(failed));
        return Ok(out);
    }
    let factory = factory(ec)?;
    // One restoration at a time; the calls below record their own state, so the lock is not held across them.
    let _running = factory
        .running
        .try_lock()
        .map_err(|_| Error::new("Subscription restoration is already running"))?;
    // Discover on every call: a request added or ended since the last call is taken or left. While the discovery
    // fails (the database does not answer), the requests found last keep being restored.
    let discovered = isolated(
        ec,
        "moqui.device.DeviceAcquisitionServices.get#StartupSubscriptions",
        &Parameters::new(),
    );
    let discovery_error = match discovered {
        Ok(found) if found.get("ready") == Some(&Value::Bool(true)) => {
            let names = match found.get("requestNames") {
                Some(Value::List(names)) => names
                    .iter()
                    .filter_map(Value::as_str)
                    .map(String::from)
                    .collect::<BTreeSet<_>>(),
                _ => BTreeSet::new(),
            };
            let mut state = lock(&factory)?;
            state.requests.retain(|name, _| names.contains(name));
            state.stopped.retain(|name| names.contains(name));
            for name in names {
                state.requests.entry(name).or_default();
            }
            None
        }
        result => {
            let message = match result {
                Ok(found) => found.get("message").map(to_plain_string).unwrap_or_default(),
                Err(error) => error.to_string(),
            };
            tracing::warn!(error = %message, "Subscription discovery failed; the requests found last are restored");
            Some(message)
        }
    };
    let now = Instant::now();
    let candidates = {
        let state = lock(&factory)?;
        state
            .requests
            .iter()
            .filter(|(name, a)| !state.stopped.contains(*name) && a.ready(now))
            .map(|(name, _)| name.clone())
            .collect::<Vec<_>>()
    };
    for name in candidates {
        let result = isolated(
            ec,
            "moqui.device.DeviceServices.run#DeviceRequest",
            &Parameters::from([("requestName".into(), Value::string(&name))]),
        );
        let (status, error) = match &result {
            Ok(r) => (
                r.get("status").and_then(Value::as_str).unwrap_or_default().to_owned(),
                r.get("errorMessage").map(to_plain_string).unwrap_or_default(),
            ),
            Err(error) => (String::new(), error.to_string()),
        };
        let mut state = lock(&factory)?;
        let Some(attempts) = state.requests.get_mut(&name) else {
            continue; // ended meanwhile
        };
        match status.as_str() {
            "unchanged" => *attempts = Attempts::default(),
            "active" | "completed" => {
                if attempts.count > 0 {
                    tracing::info!(request = %name, failed_attempts = attempts.count, "Subscription started again");
                }
                *attempts = Attempts::default();
                started.push(name);
            }
            _ => {
                attempts.record(delay, max_delay, Instant::now());
                let count = attempts.count;
                drop(state);
                tracing::warn!(
                    request = %name,
                    attempt = count,
                    error = %error,
                    "Subscription start failed; it is tried again later"
                );
                // Notified once per failure cycle; the attempts go on.
                if count == notify_after {
                    let _ = isolated(
                        ec,
                        "moqui.device.DeviceAcquisitionServices.notify#AcquisitionError",
                        &Parameters::from([
                            ("requestName".into(), Value::string(&name)),
                            (
                                "errorMessage".into(),
                                Value::string(format!(
                                    "The subscription has failed to start {count} times and is tried again: {error}"
                                )),
                            ),
                        ]),
                    );
                }
                failed.push(name);
            }
        }
    }
    let state = lock(&factory)?;
    out.insert("startedRequestNames".into(), list(started));
    out.insert("failedRequestNames".into(), list(failed));
    out.insert(
        "pendingRequestNames".into(),
        list(
            state
                .requests
                .iter()
                .filter(|(n, a)| !state.stopped.contains(*n) && a.count > 0)
                .map(|(n, _)| n.clone()),
        ),
    );
    out.insert("stoppedRequestNames".into(), list(state.stopped.iter().cloned()));
    out.insert(
        "discoveryError".into(),
        discovery_error.map(Value::string).unwrap_or(Value::Null),
    );
    Ok(out)
}

fn lock(factory: &DeviceSubscriptionsFactory) -> Result<std::sync::MutexGuard<'_, Restoration>, Error> {
    factory
        .state
        .lock()
        .map_err(|_| Error::new("Subscription state lock poisoned"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_delay_doubles_up_to_the_maximum_and_attempts_never_end() {
        let (delay, max) = (Duration::from_secs(60), Duration::from_secs(900));
        let start = Instant::now();
        let mut attempts = Attempts::default();
        let mut waits = Vec::new();
        for _ in 0..30 {
            attempts.record(delay, max, start);
            waits.push(attempts.next.unwrap() - start);
        }
        assert_eq!(&waits[..6], &[60, 120, 240, 480, 900, 900].map(Duration::from_secs));
        assert!(waits.iter().all(|w| *w <= max));
        assert_eq!(attempts.count, 30);
        assert!(!attempts.ready(start));
        assert!(attempts.ready(start + max));
    }

    #[test]
    fn a_zero_delay_retries_at_once() {
        let mut attempts = Attempts::default();
        let now = Instant::now();
        attempts.record(Duration::ZERO, Duration::ZERO, now);
        assert!(attempts.ready(now));
    }
}
