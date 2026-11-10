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

//! moqui.device.FieldbusServices.start#Subscriptions: bounded, non-blocking restoration of the subscriptions of this
//! gateway after a start, and of those that lost their connection.
use moqui_core::{
    context::ExecutionContext,
    native::{Parameters, ServiceInfo},
    transaction::TransactionAttribute,
};
use moqui_lib::{
    error::Error,
    object::{to_plain_string, Value},
};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::atomic::Ordering,
    time::{Duration, Instant},
};

#[derive(Default)]
struct Attempts {
    count: u64,
    next: Option<Instant>,
}
impl Attempts {
    fn ready(&self, max: u64, now: Instant) -> bool {
        self.count < max && self.next.is_none_or(|next| next <= now)
    }
    fn record(&mut self, delay: Duration) {
        self.count += 1;
        self.next = Some(Instant::now() + delay);
    }
}
#[derive(Default)]
pub(crate) struct Restoration {
    discovered: bool,
    discovery: Attempts,
    requests: BTreeMap<String, Attempts>,
    finished: BTreeSet<String>,
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

pub fn start(ec: &ExecutionContext, _: &ServiceInfo<'_>, params: &Parameters) -> Result<Parameters, Error> {
    let max = integer(params, "maxAttempts", 3, 1, 100)?;
    let delay = Duration::from_millis(integer(params, "retryDelayMillis", 60_000, 0, 86_400_000)?);
    let mut started = Vec::new();
    let mut failed = Vec::new();
    let mut out = Parameters::new();
    if moqui_lib::env::get_prop_or_env("device_gateway_restore_subscriptions") == "false" {
        out.insert("startedRequestNames".into(), list(started));
        out.insert("failedRequestNames".into(), list(failed));
        return Ok(out);
    }
    let gateway = crate::fieldbus::gateway(ec)?;
    let state = crate::fieldbus::store(ec)?;
    let mut restore = state
        .restoration
        .try_lock()
        .map_err(|_| Error::new("Subscription restoration is already running"))?;
    state.startup_claimed.store(true, Ordering::Release);
    let now = Instant::now();
    if !restore.discovered && restore.discovery.ready(max, now) {
        restore.discovery.record(delay);
        let discovered = isolated(
            ec,
            "moqui.device.FieldbusServices.get#StartupSubscriptions",
            &Parameters::new(),
        );
        match discovered {
            Ok(found) if found.get("ready") == Some(&Value::Bool(true)) => {
                if let Some(Value::List(names)) = found.get("requestNames") {
                    for name in names.iter().filter_map(Value::as_str) {
                        restore.requests.entry(name.to_owned()).or_default();
                    }
                }
                restore.discovered = true;
            }
            result => {
                let message = match result {
                    Ok(found) => found.get("message").map(to_plain_string).unwrap_or_default(),
                    Err(error) => error.to_string(),
                };
                tracing::warn!(attempt=restore.discovery.count, max_attempts=max, error=%message, "Gateway subscription discovery failed; retry budget is retained");
            }
        }
    }
    let (active, dropped) = gateway.block_on(gateway.facade().subscription_names());
    for name in active {
        restore.requests.remove(&name);
        restore.finished.insert(name);
    }
    for name in dropped {
        restore.finished.remove(&name);
        restore.requests.entry(name).or_default();
    }
    let stopped = state
        .stopped_subscriptions
        .lock()
        .map_err(|_| Error::new("Subscription stop registry poisoned"))?
        .clone();
    restore.requests.retain(|name, _| !stopped.contains(name));
    let candidates = restore
        .requests
        .iter()
        .filter(|(name, a)| !restore.finished.contains(*name) && a.ready(max, now))
        .map(|(name, _)| name.clone())
        .collect::<Vec<_>>();
    for name in candidates {
        let attempts = restore
            .requests
            .get_mut(&name)
            .expect("candidate was collected from this map");
        attempts.record(delay);
        let count = attempts.count;
        let result = isolated(
            ec,
            "moqui.device.DeviceServices.run#DeviceRequest",
            &Parameters::from([("requestName".into(), Value::string(&name))]),
        );
        if result
            .as_ref()
            .ok()
            .and_then(|r| r.get("status"))
            .and_then(Value::as_str)
            .is_some_and(|s| matches!(s, "active" | "completed"))
        {
            restore.finished.insert(name.clone());
            restore.requests.remove(&name);
            started.push(name);
        } else {
            tracing::warn!(request=%name, attempt=count, max_attempts=max, "Subscription start failed; other requests continue");
            if count == max {
                let _ = isolated(
                    ec,
                    "moqui.device.FieldbusServices.notify#AcquisitionError",
                    &Parameters::from([
                        ("requestName".into(), Value::string(&name)),
                        (
                            "errorMessage".into(),
                            Value::string(format!("Subscription retry limit exhausted after {count} attempts")),
                        ),
                    ]),
                );
            }
            failed.push(name);
        }
    }
    out.insert("startedRequestNames".into(), list(started));
    out.insert("failedRequestNames".into(), list(failed));
    out.insert(
        "pendingRequestNames".into(),
        list(
            restore
                .requests
                .iter()
                .filter(|(_, a)| a.count < max)
                .map(|(n, _)| n.clone()),
        ),
    );
    out.insert(
        "exhaustedRequestNames".into(),
        list(
            restore
                .requests
                .iter()
                .filter(|(_, a)| a.count >= max)
                .map(|(n, _)| n.clone()),
        ),
    );
    out.insert(
        "discoveryAttemptCount".into(),
        Value::I64(restore.discovery.count as i64),
    );
    out.insert(
        "discoveryExhausted".into(),
        Value::Bool(!restore.discovered && restore.discovery.count >= max),
    );
    Ok(out)
}
