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

//! Resolve authorized DeviceContent through the resource facade before calling a transport driver.
use moqui_core::{
    context::ExecutionContext,
    native::{Parameters, ServiceInfo},
};
use moqui_lib::{error::Error, object::Value};

pub fn transfer_files(
    ec: &ExecutionContext,
    _: &ServiceInfo<'_>,
    parameters: &Parameters,
) -> Result<Parameters, Error> {
    let required = |name: &str| {
        parameters
            .get(name)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| Error::new(format!("{name} is required")))
    };
    let name = required("requestName")?;
    let id = required("deviceContentId")?;
    let ef = ec
        .factory()
        .entity()
        .ok_or_else(|| Error::new("Entity Engine is not installed"))?;
    let request = ef
        .find("moqui.device.DeviceRequest")?
        .eq("requestName", Value::string(name))
        .use_cache(true)
        .one()?
        .ok_or_else(|| Error::new(format!("DeviceRequest {name} not found")))?;
    if request.get("requestTypeEnumId").and_then(Value::as_str) != Some("DrtContentTransfer") {
        return Err(Error::new("DeviceContent requires a DrtContentTransfer request"));
    }
    let content = ef
        .find("moqui.device.DeviceContent")?
        .eq("deviceContentId", Value::string(id))
        .use_cache(false)
        .one()?
        .ok_or_else(|| Error::new(format!("DeviceContent {id} not found")))?;
    if content.get("deviceId") != request.get("deviceId") {
        return Err(Error::new("DeviceContent belongs to a different device"));
    }
    let location = content
        .get("contentLocation")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| Error::new("DeviceContent has no resource location"))?;
    let filename = location.rsplit('/').next().unwrap_or_default();
    if filename.is_empty() || matches!(filename, "." | "..") || filename.chars().any(|c| c.is_control() || c == '\\') {
        return Err(Error::new("DeviceContent has an invalid filename"));
    }
    let bytes = ec.factory().resource().get(location)?.read_bytes()?;
    let file = Value::Map(
        [
            ("name".into(), Value::string(filename)),
            ("bytes".into(), Value::Bytes(bytes)),
        ]
        .into_iter()
        .collect(),
    );
    Ok(Parameters::from([("transferFiles".into(), Value::List(vec![file]))]))
}
