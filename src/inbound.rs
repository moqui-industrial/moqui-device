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

//! Protocol-neutral sample persistence. Drivers supply logical values, never database connections.

use moqui_core::{
    context::ExecutionContext,
    entity::{exec::PipelineWrites, Condition, EntityFacade, EntityValue},
    native::{Parameters, ServiceInfo},
    transaction::TransactionAttribute,
};
use moqui_lib::{
    error::Error,
    format::Decimal,
    object::{to_plain_string, Value},
};
use std::collections::{HashMap, HashSet};

fn text<'a>(v: &'a Value, name: &str) -> Option<&'a str> {
    match v {
        Value::Map(m) => m.get(name).and_then(Value::as_str).filter(|s| !s.is_empty()),
        _ => None,
    }
}

fn entity_text<'a>(v: &'a EntityValue, name: &str) -> Option<&'a str> {
    v.get(name).and_then(Value::as_str).filter(|s| !s.is_empty())
}

fn number(v: &Value) -> Result<Decimal, Error> {
    match v {
        Value::Decimal(n) => Ok(*n),
        Value::I64(n) => Ok(Decimal::from(*n)),
        Value::I32(n) => Ok(Decimal::from(*n)),
        Value::F64(n) if n.is_finite() => n
            .to_string()
            .parse()
            .map_err(|e| Error::new(format!("Invalid decimal: {e}"))),
        _ => Err(Error::new("Sample must be a finite number")),
    }
}

fn find(ef: &EntityFacade, name: &str, key: &str, id: &str, cache: bool) -> Result<EntityValue, Error> {
    ef.find(name)?
        .eq(key, Value::string(id))
        .use_cache(cache)
        .one()?
        .ok_or_else(|| Error::new(format!("{name} record not found: {id}")))
}

fn contains(ef: &EntityFacade, root: &str, id: &str) -> Result<bool, Error> {
    let mut pending = vec![root.to_string()];
    let mut seen = HashSet::new();
    while let Some(group) = pending.pop() {
        if !seen.insert(group.clone()) {
            continue;
        }
        if group == id {
            return Ok(true);
        }
        for member in ef
            .find("moqui.device.DeviceGroupMember")?
            .eq("deviceId", Value::string(group))
            .use_cache(true)
            .list()?
            .iter()
        {
            if entity_text(member, "statusId").is_some_and(|s| s != "DgmsAlive") {
                continue;
            }
            if let Some(child) = entity_text(member, "memberDeviceId") {
                pending.push(child.to_string());
            }
        }
    }
    Ok(false)
}

fn kind(ef: &EntityFacade, definition: &EntityValue) -> Result<&'static str, Error> {
    let mut ty = entity_text(definition, "parameterTypeEnumId")
        .ok_or_else(|| Error::new("ParameterDef has no type"))?
        .to_string();
    let mut seen = HashSet::new();
    while seen.insert(ty.clone()) {
        match ty.as_str() {
            "PtTextIndicator" => return Ok("indicator"),
            "PtByte" | "PtBitSet" | "PtEnumeration" => return Ok("bits"),
            "PtNumber" => return Ok("number"),
            _ => {}
        }
        let enumeration = find(ef, "moqui.basic.Enumeration", "enumId", &ty, true)?;
        match entity_text(&enumeration, "parentEnumId") {
            Some(parent) => ty = parent.to_string(),
            None => return Ok("text"),
        }
    }
    Err(Error::new("Cyclic parameter type hierarchy"))
}

fn value_field(value: &Value, kind: &str, width: usize) -> Result<(&'static str, Value), Error> {
    match kind {
        "number" => Ok(("numericValue", Value::Decimal(number(value)?))),
        "indicator" => match value {
            Value::Bool(b) => Ok(("symbolicValue", Value::string(if *b { "Y" } else { "N" }))),
            _ => Err(Error::new("Indicator sample is not boolean")),
        },
        "bits" => {
            let n = match value {
                Value::String(s) => u64::from_str_radix(&s.strip_prefix("0b").unwrap_or(s).replace([' ', '_'], ""), 2)
                    .map_err(|_| Error::new("Bit sample must be a binary string"))?,
                _ => {
                    let n = number(value)?;
                    if !n.fract().is_zero() {
                        return Err(Error::new("Bit sample must be an unsigned integer"));
                    }
                    u64::try_from(n).map_err(|_| Error::new("Bit sample must be an unsigned integer"))?
                }
            };
            if width < 64 && n >= (1u64 << width) {
                return Err(Error::new("Bit sample exceeds declared width"));
            }
            Ok(("parameterEnumId", Value::string(format!("{n:0width$b}"))))
        }
        _ => match value {
            Value::String(s) => Ok(("symbolicValue", Value::string(s))),
            _ => Err(Error::new("Text sample is not text")),
        },
    }
}

/// When a sample was observed: its sourceTime, else its receivedTime, else now. The flag is true for a sourceTime:
/// the device stamped the sample, so the time identifies it when a broker delivers it twice.
fn observed(sample: &Value) -> Result<(Value, bool), Error> {
    let Value::Map(m) = sample else {
        return Err(Error::new("A sample must be a map"));
    };
    // XML Actions expose timestamps as text. Normalize both fields, including the unused fallback.
    let mut observed = None;
    for key in ["sourceTime", "receivedTime"] {
        let Some(raw) = m.get(key).filter(|v| !matches!(v, Value::Null)) else {
            continue;
        };
        let normalized = match raw {
            Value::Timestamp(_) => raw.clone(),
            Value::String(_) | Value::I64(_) | Value::I32(_) => {
                moqui_lib::object::basic_convert(raw, "java.sql.Timestamp").value
            }
            _ => return Err(Error::new(format!("{key} must be a timestamp"))),
        };
        if !matches!(normalized, Value::Timestamp(_)) {
            return Err(Error::new(format!("{key} must be a timestamp")));
        }
        if observed.is_none() {
            observed = Some((normalized, key == "sourceTime"));
        }
    }
    Ok(observed.unwrap_or_else(|| (moqui_core::user::now_value(), false)))
}

/// The sample's own sequenceNum, an integer within signed 64-bit bounds.
fn sequence_of(sample: &Value) -> Result<Option<Decimal>, Error> {
    let Value::Map(m) = sample else {
        return Err(Error::new("A sample must be a map"));
    };
    let sequence = m
        .get("sequenceNum")
        .filter(|v| !matches!(v, Value::Null))
        .map(number)
        .transpose()?;
    if sequence.is_some_and(|n| !n.fract().is_zero() || i64::try_from(n).is_err()) {
        return Err(Error::new("sequenceNum must be an integer within signed 64-bit bounds"));
    }
    Ok(sequence)
}

/// The bit width of the request item's wire type, for bit-set samples.
fn item_width(item: Option<&EntityValue>) -> usize {
    match item
        .and_then(|i| entity_text(i, "itemTypeEnumId"))
        .map(str::to_ascii_uppercase)
        .as_deref()
    {
        None | Some("DRITULINT" | "DRITLWORD" | "DRITLINT" | "ULINT" | "LWORD" | "LINT") => 64,
        Some("DRITUSINT" | "DRITBYTE" | "DRITSINT" | "USINT" | "BYTE" | "SINT") => 8,
        Some("DRITUDINT" | "DRITDWORD" | "DRITDINT" | "UDINT" | "DWORD" | "DINT") => 32,
        _ => 16,
    }
}

/// The Parameter or ParameterLog field a sample writes, and its typed value.
fn typed_value(
    sample: &Value,
    value: &Value,
    kind: &str,
    width: usize,
    plc_log: bool,
) -> Result<(&'static str, Value), Error> {
    match text(sample, "logValueKind") {
        None => value_field(value, kind, width),
        Some("numeric") if plc_log => Ok(("numericValue", Value::Decimal(number(value)?))),
        Some("enumeration" | "message") if plc_log && matches!(value, Value::String(_)) => {
            Ok(("symbolicValue", value.clone()))
        }
        _ => Err(Error::new("Invalid logValueKind for this sample")),
    }
}

/// Whether a current value equals the stored one, within the item's tolerance; always false for an item that allows
/// duplicates.
fn unchanged(item: Option<&EntityValue>, kind: &str, old: &Value, typed: &Value) -> Result<bool, Error> {
    let Some(item) = item.filter(|i| entity_text(i, "allowDuplicate") != Some("Y")) else {
        return Ok(false);
    };
    if kind != "number" {
        return Ok(old == typed);
    }
    let tolerance = item
        .get("tolerance")
        .filter(|v| !matches!(v, Value::Null))
        .map(number)
        .transpose()?
        .unwrap_or(Decimal::ZERO);
    if tolerance < Decimal::ZERO {
        return Err(Error::new("Tolerance must not be negative"));
    }
    match number(old) {
        Ok(old) => Ok(number(typed)?
            .checked_sub(old)
            .ok_or_else(|| Error::new("Tolerance arithmetic overflow"))?
            .abs()
            <= tolerance),
        Err(_) => Ok(false),
    }
}

/// The next ParameterLog sequenceNum of a parameter, from its last row.
fn next_log_sequence(ef: &EntityFacade, parameter_id: &str) -> Result<Decimal, Error> {
    ef.find("moqui.math.ParameterLog")?
        .eq("parameterId", Value::string(parameter_id))
        .order_by("sequenceNum", true)
        .use_cache(false)
        .one()?
        .as_ref()
        .and_then(|r| r.get("sequenceNum"))
        .filter(|v| !matches!(v, Value::Null))
        .map(number)
        .transpose()?
        .unwrap_or(Decimal::ZERO)
        .checked_add(Decimal::ONE)
        .ok_or_else(|| Error::new("Log sequence overflow"))
}

/// The devices in the scope of the gateway this process is (`device_gateway_device_id`): `None` without a gateway,
/// an error message for every sample when its identity is not ready.
fn gateway_scope() -> Result<Result<Option<HashSet<String>>, String>, Error> {
    let gateway = moqui_lib::env::get_prop_or_env("device_gateway_device_id");
    if gateway.is_empty() {
        return Ok(Ok(None));
    }
    let scope = moqui_core::service::sync(
        "moqui.device.DeviceAcquisitionServices.get#GatewayScope",
        &Parameters::from([("gatewayDeviceId".into(), Value::string(gateway))]),
    )?;
    if !matches!(scope.get("ready"), Some(Value::Bool(true))) {
        return Ok(Err("Sample device is outside the gateway scope".into()));
    }
    Ok(Ok(Some(match scope.get("scopedDeviceIds") {
        Some(Value::List(ids)) => ids.iter().filter_map(Value::as_str).map(String::from).collect(),
        _ => HashSet::new(),
    })))
}

/// Whether a row of `entity` matches all the conditions.
fn exists(ef: &EntityFacade, entity: &str, conditions: &[(&str, Value)]) -> Result<bool, Error> {
    let mut query = ef.find(entity)?.use_cache(false);
    for (field, value) in conditions {
        query = query.eq(field, value.clone());
    }
    Ok(query.count()? > 0)
}

/// The single-sample path, in its own transaction: the fallback that isolates the sample a batch failed on. Its checks
/// are those of [`Planner::plan`], duplicates included.
fn persist(
    ef: &EntityFacade,
    request: &EntityValue,
    sample: &Value,
    plc_log: bool,
    batch_index: usize,
) -> Result<Outcome, Error> {
    let Value::Map(m) = sample else {
        return Err(Error::new("A sample must be a map"));
    };
    let device_id = text(sample, "deviceId").ok_or_else(|| Error::new("A sample requires deviceId"))?;
    let owner = entity_text(request, "deviceId").ok_or_else(|| Error::new("Request has no owning device"))?;
    if device_id != owner && !(plc_log && contains(ef, owner, device_id)?) {
        return Err(Error::new("Sample device is outside the request's device hierarchy"));
    }
    let request_name = entity_text(request, "requestName").ok_or_else(|| Error::new("Request has no name"))?;
    match gateway_scope()? {
        Err(message) => return Err(Error::new(message)),
        Ok(Some(scope)) if !scope.contains(device_id) => {
            return Err(Error::new("Sample device is outside the gateway scope"))
        }
        Ok(_) => {}
    }
    let parameter_id = text(sample, "parameterId");
    let item = if let Some(id) = parameter_id {
        ef.find("moqui.device.DeviceRequestItem")?
            .eq("requestName", Value::string(request_name))
            .eq("parameterId", Value::string(id))
            .use_cache(true)
            .one()?
    } else {
        None
    };
    if !plc_log && (parameter_id.is_none() || item.is_none()) {
        return Err(Error::new("Inbound parameter is not declared by this request"));
    }
    // The data model, not the driver or an inbound payload, decides the persistence target.
    let logging = plc_log || entity_text(request, "purposeEnumId") == Some("DrpLogging");
    let target = if parameter_id.is_none() {
        "moqui.device.DeviceLog"
    } else if logging {
        "moqui.math.ParameterLog"
    } else {
        "moqui.math.Parameter"
    };
    let transactions = ef.transactions_for(target)?;
    let tx = transactions.scope(None)?;
    find(ef, "moqui.device.Device", "deviceId", device_id, true)?;
    let (date, stamped) = observed(sample)?;
    let value = m.get("value").ok_or_else(|| Error::new("Sample requires value"))?;
    let sequence = sequence_of(sample)?;
    if let Some(id) = parameter_id {
        let mut parameter = ef
            .find("moqui.math.Parameter")?
            .eq("parameterId", Value::string(id))
            .use_cache(false)
            .for_update(!logging)
            .one()?
            .ok_or_else(|| Error::new("moqui.math.Parameter record not found"))?;
        if entity_text(&parameter, "deviceId") != Some(device_id) {
            return Err(Error::new("Sample Parameter belongs to another device"));
        }
        let definition = find(
            ef,
            "moqui.math.ParameterDef",
            "parameterDefId",
            entity_text(&parameter, "parameterDefId").ok_or_else(|| Error::new("Parameter has no definition"))?,
            true,
        )?;
        let kind = kind(ef, &definition)?;
        let (field, typed) = typed_value(sample, value, kind, item_width(item.as_ref()), plc_log)?;
        if !logging
            && unchanged(
                item.as_ref(),
                kind,
                parameter.get(field).unwrap_or(&Value::Null),
                &typed,
            )?
        {
            tx.commit()?;
            return Ok(Outcome::Unchanged);
        }
        // A log row already stored, with the device's time or the same sequenceNum: a broker delivered it again.
        let parameter_key = ("parameterId", Value::string(id));
        if logging
            && (stamped && exists(ef, target, &[parameter_key.clone(), ("observedDate", date.clone())])?
                || match sequence {
                    Some(n) => exists(ef, target, &[parameter_key, ("sequenceNum", Value::Decimal(n))])?,
                    None => false,
                })
        {
            tx.commit()?;
            return Ok(Outcome::Duplicate);
        }
        if logging {
            let mut log = ef.make_value(target)?;
            log.set_sequenced_id_primary(ef)?;
            log.set("parameterId", Value::string(id));
            log.set(
                "sequenceNum",
                Value::Decimal(match sequence {
                    Some(n) => n,
                    None => next_log_sequence(ef, id)?,
                }),
            );
            log.set("observedDate", date);
            log.set(field, typed);
            log.create(ef)?;
        } else {
            parameter.set(field, typed);
            parameter.update(ef)?;
        }
    } else {
        if let (true, Some(n)) = (stamped, sequence) {
            let key = [
                ("deviceId", Value::string(device_id)),
                ("observedDate", date.clone()),
                ("sequenceNum", Value::Decimal(n)),
            ];
            if exists(ef, target, &key)? {
                tx.commit()?;
                return Ok(Outcome::Duplicate);
            }
        }
        let mut log = ef.make_value(target)?;
        log.set_sequenced_id_primary(ef)?;
        log.set("deviceId", Value::string(device_id));
        log.set("payload", Value::string(moqui_lib::json::to_json(value).to_string()));
        log.set(
            "sequenceNum",
            Value::Decimal(sequence.unwrap_or(Decimal::from(batch_index + 1))),
        );
        log.set("observedDate", date);
        log.create(ef)?;
    }
    tx.commit()?;
    Ok(Outcome::Stored)
}

/// Samples written in one transaction. A data file's load writes the same way: reads first, then every write sent
/// without waiting for its result, several rows to an insert statement.
const CHUNK: usize = 1000;
const CHUNK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

/// A microsecond key of a timestamp, the precision the databases keep.
fn micros(v: &Value) -> Option<i64> {
    match v {
        Value::Timestamp(t) => Some(t.as_microsecond()),
        _ => None,
    }
}

fn integer(v: &Value) -> Option<i64> {
    number(v).ok().and_then(|n| i64::try_from(n).ok())
}

/// What the store did with one sample.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Outcome {
    Stored,
    /// A current value equal to the stored one.
    Unchanged,
    /// A log row already stored: the same device-stamped time, or the same sequenceNum, of the same parameter. A
    /// broker redelivers what was stored but not yet acknowledged.
    Duplicate,
}

impl Outcome {
    fn status(self) -> &'static str {
        match self {
            Self::Stored => "stored",
            Self::Unchanged => "unchanged",
            Self::Duplicate => "duplicate",
        }
    }
}

/// One chunk of a batch: what it reads once, and the rows it writes.
struct Planner<'a> {
    ef: &'a EntityFacade,
    request_name: &'a str,
    owner: &'a str,
    plc_log: bool,
    logging: bool,
    scope: &'a Result<Option<HashSet<String>>, String>,
    hierarchy: HashMap<String, bool>,
    devices: HashSet<String>,
    parameters: HashMap<String, EntityValue>,
    kinds: HashMap<String, &'static str>,
    next_sequence: HashMap<String, Decimal>,
    /// ParameterLog rows by (parameterId, observedDate) and (parameterId, sequenceNum), stored or planned.
    log_times: HashSet<(String, i64)>,
    log_sequences: HashSet<(String, i64)>,
    /// Device-stamped DeviceLog rows with their own sequenceNum, by (deviceId, observedDate, sequenceNum).
    device_logs: HashSet<(String, i64, i64)>,
    creates: Vec<EntityValue>,
    /// The current values that change, with the fields planned for each, in the order planned.
    updated: Vec<(String, Vec<&'static str>)>,
}

impl<'a> Planner<'a> {
    /// The rows a chunk needs, in a few statements: its Parameters, and the log rows that could already hold its
    /// samples. The Parameters come from the entity cache (`Parameter` is `cache="true"`): a polling request asks for
    /// the same parameters at every cycle, so an unchanged value is skipped without a database read. Only the
    /// Parameters that change are read again, locked, by [`Self::write`]. The cache is right for one node, since the
    /// Entity Engine clears it on every write; a cache another node does not clear would leave a change unwritten.
    fn load(&mut self, samples: &[Value], times: &[Result<(Value, bool), Error>]) -> Result<(), Error> {
        let mut ids = Vec::new();
        let mut log_dates = Vec::new();
        let mut log_sequences = Vec::new();
        let mut devices = Vec::new();
        let mut device_dates = Vec::new();
        for (sample, time) in samples.iter().zip(times) {
            let Ok((date, stamped)) = time else { continue };
            match text(sample, "parameterId") {
                Some(id) => {
                    let id = Value::string(id);
                    if !ids.contains(&id) {
                        ids.push(id);
                    }
                    if self.logging {
                        if !log_dates.contains(date) {
                            log_dates.push(date.clone());
                        }
                        if let Ok(Some(n)) = sequence_of(sample) {
                            let n = Value::Decimal(n);
                            if !log_sequences.contains(&n) {
                                log_sequences.push(n);
                            }
                        }
                    }
                }
                None if *stamped && matches!(sequence_of(sample), Ok(Some(_))) => {
                    if let Some(device) = text(sample, "deviceId").map(Value::string) {
                        if !devices.contains(&device) {
                            devices.push(device);
                        }
                    }
                    if !device_dates.contains(date) {
                        device_dates.push(date.clone());
                    }
                }
                None => {}
            }
        }
        if ids.is_empty() && devices.is_empty() {
            return Ok(());
        }
        let ef = self.ef;
        if !ids.is_empty() {
            for parameter in ef
                .find("moqui.math.Parameter")?
                .condition(Condition::is_in("parameterId", ids.clone()))
                .use_cache(true)
                .list()?
                .iter()
            {
                if let Some(id) = entity_text(parameter, "parameterId") {
                    self.parameters.insert(id.to_string(), parameter.clone());
                }
            }
        }
        let rows = |entity: &str, conditions: Vec<Condition>| -> Result<_, Error> {
            ef.find(entity)?
                .condition(Condition::and(conditions))
                .use_cache(false)
                .list()
        };
        if !log_dates.is_empty() {
            let found = rows(
                "moqui.math.ParameterLog",
                vec![
                    Condition::is_in("parameterId", ids.clone()),
                    Condition::is_in("observedDate", log_dates),
                ],
            )?;
            for row in found.iter() {
                if let (Some(id), Some(at)) = (
                    entity_text(row, "parameterId"),
                    row.get("observedDate").and_then(micros),
                ) {
                    self.log_times.insert((id.to_string(), at));
                }
            }
        }
        if !log_sequences.is_empty() {
            let found = rows(
                "moqui.math.ParameterLog",
                vec![
                    Condition::is_in("parameterId", ids),
                    Condition::is_in("sequenceNum", log_sequences),
                ],
            )?;
            for row in found.iter() {
                if let (Some(id), Some(n)) = (
                    entity_text(row, "parameterId"),
                    row.get("sequenceNum").and_then(integer),
                ) {
                    self.log_sequences.insert((id.to_string(), n));
                }
            }
        }
        if !devices.is_empty() {
            let found = rows(
                "moqui.device.DeviceLog",
                vec![
                    Condition::is_in("deviceId", devices),
                    Condition::is_in("observedDate", device_dates),
                ],
            )?;
            for row in found.iter() {
                if let (Some(device), Some(at), Some(n)) = (
                    entity_text(row, "deviceId"),
                    row.get("observedDate").and_then(micros),
                    row.get("sequenceNum").and_then(integer),
                ) {
                    self.device_logs.insert((device.to_string(), at, n));
                }
            }
        }
        Ok(())
    }

    fn in_hierarchy(&mut self, device_id: &str) -> Result<bool, Error> {
        if let Some(known) = self.hierarchy.get(device_id) {
            return Ok(*known);
        }
        let inside = contains(self.ef, self.owner, device_id)?;
        self.hierarchy.insert(device_id.to_string(), inside);
        Ok(inside)
    }

    fn kind(&mut self, definition_id: &str) -> Result<&'static str, Error> {
        if let Some(kind) = self.kinds.get(definition_id) {
            return Ok(kind);
        }
        let definition = find(
            self.ef,
            "moqui.math.ParameterDef",
            "parameterDefId",
            definition_id,
            true,
        )?;
        let kind = kind(self.ef, &definition)?;
        self.kinds.insert(definition_id.to_string(), kind);
        Ok(kind)
    }

    /// Validate one sample against the request and plan its write, without writing. The checks are those of
    /// [`persist`].
    fn plan(&mut self, sample: &Value, index: usize, time: &(Value, bool)) -> Result<Outcome, Error> {
        let Value::Map(m) = sample else {
            return Err(Error::new("A sample must be a map"));
        };
        let ef = self.ef;
        let device_id = text(sample, "deviceId").ok_or_else(|| Error::new("A sample requires deviceId"))?;
        if device_id != self.owner && !(self.plc_log && self.in_hierarchy(device_id)?) {
            return Err(Error::new("Sample device is outside the request's device hierarchy"));
        }
        match self.scope {
            Err(message) => return Err(Error::new(message.clone())),
            Ok(Some(scope)) if !scope.contains(device_id) => {
                return Err(Error::new("Sample device is outside the gateway scope"))
            }
            Ok(_) => {}
        }
        let parameter_id = text(sample, "parameterId");
        let item = match parameter_id {
            Some(id) => ef
                .find("moqui.device.DeviceRequestItem")?
                .eq("requestName", Value::string(self.request_name))
                .eq("parameterId", Value::string(id))
                .use_cache(true)
                .one()?,
            None => None,
        };
        if !self.plc_log && (parameter_id.is_none() || item.is_none()) {
            return Err(Error::new("Inbound parameter is not declared by this request"));
        }
        if !self.devices.contains(device_id) {
            find(ef, "moqui.device.Device", "deviceId", device_id, true)?;
            self.devices.insert(device_id.to_string());
        }
        let (date, stamped) = time.clone();
        let value = m.get("value").ok_or_else(|| Error::new("Sample requires value"))?;
        let sequence = sequence_of(sample)?;
        let Some(id) = parameter_id else {
            let sequence_num = sequence.unwrap_or(Decimal::from(index + 1));
            if stamped && sequence.is_some() {
                let key = (
                    device_id.to_string(),
                    micros(&date).unwrap_or_default(),
                    i64::try_from(sequence_num).unwrap_or_default(),
                );
                if !self.device_logs.insert(key) {
                    return Ok(Outcome::Duplicate);
                }
            }
            let mut log = ef.make_value("moqui.device.DeviceLog")?;
            log.set_sequenced_id_primary(ef)?;
            log.set("deviceId", Value::string(device_id));
            log.set("payload", Value::string(moqui_lib::json::to_json(value).to_string()));
            log.set("sequenceNum", Value::Decimal(sequence_num));
            log.set("observedDate", date);
            self.creates.push(log);
            return Ok(Outcome::Stored);
        };
        let definition_id = {
            let parameter = self
                .parameters
                .get(id)
                .ok_or_else(|| Error::new("moqui.math.Parameter record not found"))?;
            if entity_text(parameter, "deviceId") != Some(device_id) {
                return Err(Error::new("Sample Parameter belongs to another device"));
            }
            entity_text(parameter, "parameterDefId")
                .ok_or_else(|| Error::new("Parameter has no definition"))?
                .to_string()
        };
        let kind = self.kind(&definition_id)?;
        let (field, typed) = typed_value(sample, value, kind, item_width(item.as_ref()), self.plc_log)?;
        if self.logging {
            let time_key = (id.to_string(), micros(&date).unwrap_or_default());
            let sequence_key = sequence.map(|n| (id.to_string(), i64::try_from(n).unwrap_or_default()));
            if stamped && self.log_times.contains(&time_key)
                || sequence_key.as_ref().is_some_and(|k| self.log_sequences.contains(k))
            {
                return Ok(Outcome::Duplicate);
            }
            if self.log_times.contains(&time_key) {
                return Err(Error::new(
                    "A ParameterLog of this parameter already exists at this time",
                ));
            }
            let sequence_num = match sequence {
                Some(n) => {
                    if let Some(next) = self.next_sequence.get_mut(id) {
                        *next = (*next).max(n + Decimal::ONE);
                    }
                    n
                }
                None => {
                    let n = match self.next_sequence.get(id) {
                        Some(n) => *n,
                        None => next_log_sequence(ef, id)?,
                    };
                    self.next_sequence.insert(id.to_string(), n + Decimal::ONE);
                    n
                }
            };
            self.log_times.insert(time_key);
            self.log_sequences
                .insert((id.to_string(), i64::try_from(sequence_num).unwrap_or_default()));
            let mut log = ef.make_value("moqui.math.ParameterLog")?;
            log.set_sequenced_id_primary(ef)?;
            log.set("parameterId", Value::string(id));
            log.set("sequenceNum", Value::Decimal(sequence_num));
            log.set("observedDate", date);
            log.set(field, typed);
            self.creates.push(log);
        } else {
            let parameter = self
                .parameters
                .get_mut(id)
                .ok_or_else(|| Error::new("moqui.math.Parameter record not found"))?;
            if unchanged(
                item.as_ref(),
                kind,
                parameter.get(field).unwrap_or(&Value::Null),
                &typed,
            )? {
                return Ok(Outcome::Unchanged);
            }
            // Only the last value of a parameter is written: a current value keeps no history.
            parameter.set(field, typed);
            match self.updated.iter_mut().find(|(u, _)| u == id) {
                Some((_, fields)) if !fields.contains(&field) => fields.push(field),
                Some(_) => {}
                None => self.updated.push((id.to_string(), vec![field])),
            }
        }
        Ok(Outcome::Stored)
    }

    /// Lock the Parameters whose current value changes, set the planned fields on them, and send the writes without
    /// waiting for each result.
    fn write(&self) -> Result<(), Error> {
        let mut locked = HashMap::new();
        if !self.updated.is_empty() {
            let ids = self.updated.iter().map(|(id, _)| Value::string(id)).collect();
            for row in self
                .ef
                .find("moqui.math.Parameter")?
                .condition(Condition::is_in("parameterId", ids))
                .use_cache(false)
                .for_update(true)
                .list()?
                .iter()
            {
                if let Some(id) = entity_text(row, "parameterId") {
                    locked.insert(id.to_string(), row.clone());
                }
            }
        }
        let _pipeline = PipelineWrites::enter();
        for value in &self.creates {
            value.create(self.ef)?;
        }
        for (id, fields) in &self.updated {
            let (Some(planned), Some(mut row)) = (self.parameters.get(id), locked.remove(id)) else {
                return Err(Error::new("moqui.math.Parameter record not found"));
            };
            for field in fields {
                row.set(*field, planned.get(field).cloned().unwrap_or(Value::Null));
            }
            row.update(self.ef)?;
        }
        Ok(())
    }
}

/// Whether the database answers: a failure with an answering database belongs to the samples, not the database.
fn database_available(ef: &EntityFacade, request_name: &str) -> bool {
    let Ok(transactions) = ef.transactions_for("moqui.device.DeviceRequest") else {
        return false;
    };
    transactions
        .run(
            TransactionAttribute::ForceNew,
            Some(std::time::Duration::from_secs(10)),
            || {
                ef.find("moqui.device.DeviceRequest")?
                    .eq("requestName", Value::string(request_name))
                    .use_cache(false)
                    .one()
            },
        )
        .is_ok()
}

/// The samples of a request, a chunk at a time: one transaction per chunk, reads first, then the writes sent
/// together. A sample that fails validation is reported and skipped; the others of its chunk are written. When a
/// chunk's transaction fails and the database answers, its samples are written one by one to isolate the failing
/// one. When the database does not answer, nothing more is written and `retryable` is true, with `retryFromIndex`
/// the first sample to send again: a durable source keeps them until then.
pub fn store_samples(
    ec: &ExecutionContext,
    info: &ServiceInfo<'_>,
    parameters: &Parameters,
) -> Result<Parameters, Error> {
    let ef = ec
        .factory()
        .entity()
        .ok_or_else(|| Error::new("Entity Engine is not installed"))?;
    let name = parameters
        .get("requestName")
        .and_then(Value::as_str)
        .ok_or_else(|| Error::new("requestName is required"))?;
    let samples = match parameters.get("samples") {
        Some(Value::List(samples)) => samples.as_slice(),
        None | Some(Value::Null) => &[],
        _ => return Err(Error::new("samples must be a list")),
    };
    let mut store = Store {
        results: Vec::with_capacity(samples.len()),
        ..Store::default()
    };
    let request = match ef
        .find("moqui.device.DeviceRequest")?
        .eq("requestName", Value::string(name))
        .use_cache(true)
        .one()
    {
        Ok(Some(request)) => request,
        Ok(None) => {
            return Err(Error::new(format!(
                "moqui.device.DeviceRequest record not found: {name}"
            )))
        }
        Err(error) if !database_available(&ef, name) => {
            tracing::warn!(request = name, error = %error, "Database unavailable; samples kept for a retry");
            return finish(ec, parameters, &[], store, Some(0));
        }
        Err(error) => return Err(error),
    };
    let plc_log = info.name.ends_with("store#LogSamples");
    let scope = match gateway_scope() {
        Ok(scope) => scope,
        Err(error) if !database_available(&ef, name) => {
            tracing::warn!(request = name, error = %error, "Database unavailable; samples kept for a retry");
            return finish(ec, parameters, &[], store, Some(0));
        }
        Err(error) => Err(error.to_string()),
    };
    let owner = entity_text(&request, "deviceId").ok_or_else(|| Error::new("Request has no owning device"))?;
    // The data model, not the driver or an inbound payload, decides the persistence target.
    let logging = plc_log || entity_text(&request, "purposeEnumId") == Some("DrpLogging");
    let transactions = ef.transactions_for("moqui.math.ParameterLog")?;
    let single = ef.transactions_for("moqui.device.DeviceRequest")?;
    for (number, chunk) in samples.chunks(CHUNK).enumerate() {
        let offset = number * CHUNK;
        let times: Vec<_> = chunk.iter().map(observed).collect();
        let planned = transactions.run(TransactionAttribute::ForceNew, Some(CHUNK_TIMEOUT), || {
            let mut planner = Planner {
                ef: &ef,
                request_name: name,
                owner,
                plc_log,
                logging,
                scope: &scope,
                hierarchy: HashMap::new(),
                devices: HashSet::new(),
                parameters: HashMap::new(),
                kinds: HashMap::new(),
                next_sequence: HashMap::new(),
                log_times: HashSet::new(),
                log_sequences: HashSet::new(),
                device_logs: HashSet::new(),
                creates: Vec::new(),
                updated: Vec::new(),
            };
            planner.load(chunk, &times)?;
            let outcomes: Vec<Result<Outcome, Error>> = chunk
                .iter()
                .zip(&times)
                .enumerate()
                .map(|(i, (sample, time))| match time {
                    Ok(time) => planner.plan(sample, offset + i, time),
                    Err(error) => Err(Error::new(error.to_string())),
                })
                .collect();
            planner.write()?;
            transactions.finish_deferred()?;
            Ok(outcomes)
        });
        let outcomes = match planned {
            Ok(outcomes) => outcomes,
            Err(error) if !database_available(&ef, name) => {
                tracing::warn!(request = name, error = %error, "Database unavailable; samples kept for a retry");
                return finish(ec, parameters, &samples[..offset], store, Some(offset));
            }
            Err(error) => {
                tracing::warn!(request = name, error = %error, "Sample chunk failed; storing its samples one by one");
                let outcomes: Vec<Result<Outcome, Error>> = chunk
                    .iter()
                    .enumerate()
                    .map(|(i, sample)| {
                        single.run(TransactionAttribute::IgnoreSuspend, None, || {
                            persist(&ef, &request, sample, plc_log, offset + i)
                        })
                    })
                    .collect();
                if outcomes.iter().all(Result::is_err) && !database_available(&ef, name) {
                    tracing::warn!(request = name, "Database unavailable; samples kept for a retry");
                    return finish(ec, parameters, &samples[..offset], store, Some(offset));
                }
                outcomes
            }
        };
        for (sample, outcome) in chunk.iter().zip(outcomes) {
            store.record(name, sample, outcome);
        }
    }
    finish(ec, parameters, samples, store, None)
}

#[derive(Default)]
struct Store {
    results: Vec<Value>,
    stored: i64,
    duplicates: i64,
    failed: i64,
}

impl Store {
    fn record(&mut self, request_name: &str, sample: &Value, outcome: Result<Outcome, Error>) {
        let (status, error) = match outcome {
            Ok(outcome) => {
                match outcome {
                    Outcome::Stored => self.stored += 1,
                    Outcome::Duplicate => self.duplicates += 1,
                    Outcome::Unchanged => {}
                }
                (outcome.status(), Value::Null)
            }
            Err(error) => {
                tracing::error!(request = request_name, index = self.results.len(), error = %error,
                    "Sample rejected; remaining samples continue");
                self.failed += 1;
                ("failed", Value::string(error.to_string()))
            }
        };
        self.results.push(Value::Map(
            [
                (
                    "parameterId".into(),
                    text(sample, "parameterId").map(Value::string).unwrap_or(Value::Null),
                ),
                ("status".into(), Value::string(status)),
                ("error".into(), error),
            ]
            .into_iter()
            .collect(),
        ));
    }
}

/// The service result, the acquisition error notice and the after-store hook. With `retry_from`, `done` are the
/// samples committed before the database stopped answering; acquisition errors wait for the retry.
fn finish(
    ec: &ExecutionContext,
    parameters: &Parameters,
    done: &[Value],
    store: Store,
    retry_from: Option<usize>,
) -> Result<Parameters, Error> {
    let name = parameters
        .get("requestName")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let acquisition_errors = match parameters.get("acquisitionErrors") {
        Some(Value::List(errors)) if retry_from.is_none() => errors.clone(),
        _ => Vec::new(),
    };
    for error in &acquisition_errors {
        tracing::error!(
            request = name,
            error = %to_plain_string(error),
            "Device acquisition error; valid samples continue"
        );
    }
    let Store {
        results,
        stored,
        duplicates,
        failed,
    } = store;
    let out = Parameters::from([
        ("results".into(), Value::List(results)),
        ("storedCount".into(), Value::I64(stored)),
        ("failedCount".into(), Value::I64(failed)),
        ("duplicateCount".into(), Value::I64(duplicates)),
        (
            "acquisitionErrorCount".into(),
            Value::I64(acquisition_errors.len() as i64),
        ),
        ("retryable".into(), Value::Bool(retry_from.is_some())),
        (
            "retryFromIndex".into(),
            retry_from.map_or(Value::Null, |i| Value::I64(i as i64)),
        ),
    ]);
    let transactions = ec
        .factory()
        .entity()
        .ok_or_else(|| Error::new("Entity Engine is not installed"))?
        .transactions_for("moqui.device.DeviceRequest")?;
    if (failed > 0 || !acquisition_errors.is_empty()) && parameters.get("notifyErrors") != Some(&Value::Bool(false)) {
        let mut errors = acquisition_errors.iter().map(to_plain_string).collect::<Vec<_>>();
        if let Some(Value::List(results)) = out.get("results") {
            errors.extend(results.iter().filter_map(|r| text(r, "error").map(String::from)));
        }
        let report = Parameters::from([
            ("requestName".into(), Value::string(name)),
            ("errorMessage".into(), Value::string(errors.join("; "))),
        ]);
        let mark = ec.message().error_mark();
        let _ = transactions.run(TransactionAttribute::ForceNew, None, || {
            moqui_core::service::sync(
                "moqui.device.DeviceAcquisitionServices.notify#AcquisitionError",
                &report,
            )
            .map_err(|e| Error::new(e.to_string()))
        });
        ec.message().take_errors_since(mark);
    }
    // Only a batch that wrote something: a polling cycle whose values did not change costs no service call.
    if stored > 0 {
        let mut callback = parameters.clone();
        callback.insert("samples".into(), Value::List(done.to_vec()));
        callback.extend(out.clone());
        let mark = ec.message().error_mark();
        // The framework logs hook failures. They must not invalidate already committed measurements.
        let _ = transactions.run(TransactionAttribute::ForceNew, None, || {
            moqui_core::service::sync("moqui.device.DeviceAcquisitionServices.after#Samples", &callback)
                .map_err(|e| Error::new(e.to_string()))
        });
        ec.message().take_errors_since(mark);
    }
    Ok(out)
}
