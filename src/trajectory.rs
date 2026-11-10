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

//! The tool `TrajectoryGenerator` of TrajectoryPlannerServices.xml: the Rust port of the Groovy class
//! `org.moqui.device.TrajectoryGenerator` of the Java version, and of the work the services' Groovy scripts did on
//! bytes and numbers. The scripts call it as they called the class:
//! `ec.getTool('TrajectoryGenerator').normalizePoseVector(startPose, 'startPose')`.
//!
//! - `normalizePoseVector(value, fieldName)`: six TCP pose numbers [X,Y,Z,A,B,C].
//! - `normalizeNumberList(value, fieldName, minSize)`: the numbers of an OpenVLA grounding answer, as decimals.
//! - `imageBase64(location)`: the bytes of a resource in Base64, the image an OpenVLA call sends.
//! - `runInference(onnxContentLocation, startPose, goalPose)`: the waypoints of the ONNX planner, with ONNX Runtime
//!   (the `onnx` feature) in place of DJL. The model takes [tcp_start(6) || tcp_goal(6)] as a float [1,12] input and
//!   gives N waypoints x 6 TCP pose values flat in its first output.
//! - `sessionCount()`, `loadCount()`, `clear()`: the loaded models, which the factory keeps between calls.
//!
//! A local model file is loaded once and kept while its size and time (and those of its `.data` file) stay the same,
//! up to `onnx.session.cache.max` models; the Groovy version loaded the model on every call. A model at another kind
//! of location is copied to a temporary directory and loaded for the call, as the Groovy version did.

use base64::Engine;
use moqui_core::context::{Error, ExecutionContext};
use moqui_core::native::{Tool, ToolFactory};
use moqui_lib::format::Decimal;
use moqui_lib::object::Value;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

/// The components of a TCP pose: X, Y, Z, A, B, C.
pub(crate) const POSE: usize = 6;

/// A Groovy type name for a value of the wrong type, as `value?.getClass()?.getSimpleName()` gave.
fn type_name(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "Boolean",
        Value::List(_) => "List",
        Value::Map(_) => "Map",
        Value::Bytes(_) => "byte[]",
        Value::Timestamp(_) | Value::Date(_) | Value::Time(_) => "Date",
        _ => "Object",
    }
}

/// TrajectoryGenerator.normalizePoseVector: a List of exactly six numbers, or texts of numbers.
pub(crate) fn normalize_pose_vector(value: &Value, field_name: &str) -> Result<Vec<f64>, String> {
    let Value::List(values) = value else {
        return Err(format!("{field_name} must be a List with exactly 6 numeric values."));
    };
    if values.len() != POSE {
        return Err(format!(
            "{field_name} must contain exactly 6 numeric values, found {}.",
            values.len()
        ));
    }
    values
        .iter()
        .enumerate()
        .map(|(index, value)| match value {
            Value::I32(number) => Ok(f64::from(*number)),
            Value::I64(number) => Ok(*number as f64),
            Value::F64(number) => Ok(*number),
            Value::Decimal(number) => number
                .to_string()
                .parse::<f64>()
                .map_err(|_| format!("{field_name}[{index}] must be numeric, found value '{number}'.")),
            Value::String(text) => {
                let text = text.trim();
                if text.is_empty() {
                    return Err(format!("{field_name}[{index}] must not be empty."));
                }
                text.parse::<f64>()
                    .map_err(|_| format!("{field_name}[{index}] must be numeric, found value '{text}'."))
            }
            other => Err(format!(
                "{field_name}[{index}] must be numeric, found {}.",
                type_name(other)
            )),
        })
        .collect()
}

/// The normalizeNumberList closure of run#OpenVlaGrounding: null stays null, a single value is a list of one, and
/// each entry is a decimal (`new BigDecimal(entry.toString())`); at least `min_size` of them when one is given.
pub(crate) fn normalize_number_list(
    value: &Value,
    field_name: &str,
    min_size: Option<usize>,
) -> Result<Option<Vec<Decimal>>, String> {
    let entries = match value {
        Value::Null => return Ok(None),
        Value::List(values) => values.as_slice(),
        single => std::slice::from_ref(single),
    };
    let normalized = entries
        .iter()
        .enumerate()
        .map(|(index, entry)| {
            let text = match entry {
                Value::Null => String::new(),
                Value::String(text) => text.trim().to_string(),
                Value::I32(number) => number.to_string(),
                Value::I64(number) => number.to_string(),
                Value::F64(number) => number.to_string(),
                Value::Decimal(number) => number.to_string(),
                other => return Err(format!("{field_name}[{index}] is not a number: {}.", type_name(other))),
            };
            if text.is_empty() {
                return Err(format!("{field_name}[{index}] is empty."));
            }
            text.parse::<Decimal>()
                .map_err(|_| format!("{field_name}[{index}] is not a number: {text}."))
        })
        .collect::<Result<Vec<_>, _>>()?;
    if let Some(min_size) = min_size.filter(|min_size| normalized.len() < *min_size) {
        return Err(format!("{field_name} must contain at least {min_size} values."));
    }
    Ok(Some(normalized))
}

/// The flat output of the model as waypoints of six TCP pose values.
// Used by the inference of the onnx feature, and by the unit tests without it.
#[cfg_attr(not(feature = "onnx"), allow(dead_code))]
pub(crate) fn waypoints(output: &[f32]) -> Result<Vec<Vec<f64>>, String> {
    if output.is_empty() {
        return Err("Trajectory inference returned an empty output tensor.".into());
    }
    if !output.len().is_multiple_of(POSE) {
        return Err(format!(
            "Trajectory inference returned {} values, not divisible by 6 TCP pose components.",
            output.len()
        ));
    }
    Ok(output
        .chunks(POSE)
        .map(|pose| pose.iter().map(|value| f64::from(*value)).collect())
        .collect())
}

/// The model input: [tcp_start(6) || tcp_goal(6)] as floats.
// Used by the inference of the onnx feature, and by the unit tests without it.
#[cfg_attr(not(feature = "onnx"), allow(dead_code))]
pub(crate) fn model_input(start_pose: &[f64], goal_pose: &[f64]) -> Vec<f32> {
    start_pose.iter().chain(goal_pose).map(|value| *value as f32).collect()
}

/// The decimal list a script reads, or null.
fn decimal_list(values: Option<Vec<Decimal>>) -> Value {
    values.map_or(Value::Null, |values| {
        Value::List(values.into_iter().map(Value::Decimal).collect())
    })
}

/// The number list a script reads.
fn number_list(values: &[f64]) -> Value {
    Value::List(values.iter().map(|value| Value::F64(*value)).collect())
}

fn text_argument<'a>(arguments: &'a [Value], index: usize, name: &str) -> Result<&'a str, Error> {
    arguments
        .get(index)
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .ok_or_else(|| Error::new(format!("{name} is required")))
}

fn size_argument(value: Option<&Value>) -> Result<Option<usize>, Error> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::I32(size)) => Ok(usize::try_from(*size).ok()),
        Some(Value::I64(size)) => Ok(usize::try_from(*size).ok()),
        Some(Value::F64(size)) if size.is_finite() && *size >= 0.0 => Ok(Some(*size as usize)),
        Some(Value::Decimal(size)) => Ok(size.to_string().parse::<f64>().ok().map(|size| size as usize)),
        Some(_) => Err(Error::new("minSize must be a number")),
    }
}

/// imageBase64: the bytes at a location, encoded for the JSON body of an OpenVLA call.
fn image_base64(ec: &ExecutionContext, location: &str) -> Result<String, Error> {
    let resource = ec
        .factory()
        .resource()
        .get(location)
        .map_err(|error| Error::new(format!("Could not resolve image location {location}: {error}")))?;
    let bytes = resource
        .read_bytes()
        .map_err(|error| Error::new(format!("Could not read image location {location}: {error}")))?;
    if bytes.is_empty() {
        return Err(Error::new(format!("Image at {location} is empty.")));
    }
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

/// The models the factory keeps loaded, one per local model file.
#[derive(Default)]
pub struct Sessions {
    closed: AtomicBool,
    loads: AtomicU64,
    #[cfg(feature = "onnx")]
    clock: AtomicU64,
    #[cfg(feature = "onnx")]
    entries: std::sync::Mutex<std::collections::HashMap<String, onnx::Entry>>,
}

impl Sessions {
    fn clear(&self) {
        #[cfg(feature = "onnx")]
        if let Ok(mut entries) = self.entries.lock() {
            entries.clear();
        }
    }

    fn count(&self) -> usize {
        #[cfg(feature = "onnx")]
        {
            self.entries.lock().map(|entries| entries.len()).unwrap_or(0)
        }
        #[cfg(not(feature = "onnx"))]
        {
            0
        }
    }

    /// runInference: the waypoints of the model at the location and the milliseconds the model ran.
    fn run_inference(
        &self,
        ec: &ExecutionContext,
        location: &str,
        start_pose: &[f64],
        goal_pose: &[f64],
    ) -> Result<(Vec<Vec<f64>>, u64), Error> {
        if self.closed.load(Ordering::Acquire) {
            return Err(Error::new("The TrajectoryGenerator tool is shutting down."));
        }
        #[cfg(feature = "onnx")]
        {
            let (output, latency) = onnx::infer(self, ec, location, &model_input(start_pose, goal_pose))
                .map_err(|error| Error::new(format!("Trajectory inference failed: {error}")))?;
            Ok((waypoints(&output).map_err(Error::new)?, latency))
        }
        #[cfg(not(feature = "onnx"))]
        {
            let _ = (ec, location, start_pose, goal_pose);
            Err(Error::new(
                "Trajectory inference needs the onnx feature of moqui-device: build with \
                 ./moq build -- --features moqui-device/onnx and set ORT_DYLIB_PATH to the ONNX Runtime library.",
            ))
        }
    }
}

#[cfg(feature = "onnx")]
mod onnx {
    //! ONNX Runtime sessions for the planner model.
    use super::Sessions;
    use moqui_core::context::ExecutionContext;
    use ort::{session::Session, value::Tensor};
    use std::path::{Path, PathBuf};
    use std::sync::atomic::Ordering;
    use std::sync::{Arc, Mutex};

    pub(super) struct Entry {
        fingerprint: String,
        session: Arc<Mutex<Session>>,
        used: u64,
    }

    fn load(path: &Path) -> Result<Session, String> {
        Session::builder()
            .and_then(|builder| builder.with_intra_threads(1))
            .and_then(|builder| builder.commit_from_file(path))
            .map_err(|error| error.to_string())
    }

    /// The size and time of the model file and of its external data file, which change when either is replaced.
    fn fingerprint(path: &Path) -> Result<String, String> {
        let stat = |path: &Path| {
            std::fs::metadata(path)
                .ok()
                .map(|metadata| (metadata.len(), metadata.modified().ok()))
        };
        let model = stat(path).ok_or_else(|| format!("ONNX model file does not exist: {}", path.display()))?;
        let data = stat(&PathBuf::from(format!("{}.data", path.display())));
        Ok(format!("{model:?}:{data:?}"))
    }

    /// The kept session of a local model file, loaded again when the file changed.
    fn cached(sessions: &Sessions, path: &Path) -> Result<Arc<Mutex<Session>>, String> {
        let key = path
            .canonicalize()
            .map_err(|error| format!("{}: {error}", path.display()))?
            .display()
            .to_string();
        let fingerprint = fingerprint(path)?;
        let mut entries = sessions
            .entries
            .lock()
            .map_err(|_| "the ONNX session registry is poisoned".to_string())?;
        if !entries.get(&key).is_some_and(|entry| entry.fingerprint == fingerprint) {
            let session = load(path)?;
            let max = moqui_lib::env::get_prop_or_env("onnx.session.cache.max")
                .parse::<usize>()
                .unwrap_or(8)
                .max(1);
            if !entries.contains_key(&key) && entries.len() >= max {
                let oldest = entries
                    .iter()
                    .min_by_key(|(_, entry)| entry.used)
                    .map(|(key, _)| key.clone());
                if let Some(oldest) = oldest {
                    entries.remove(&oldest);
                }
            }
            entries.insert(
                key.clone(),
                Entry {
                    fingerprint,
                    session: Arc::new(Mutex::new(session)),
                    used: 0,
                },
            );
            sessions.loads.fetch_add(1, Ordering::Relaxed);
        }
        let entry = entries
            .get_mut(&key)
            .ok_or_else(|| "the ONNX session was not kept".to_string())?;
        entry.used = sessions.clock.fetch_add(1, Ordering::Relaxed);
        Ok(Arc::clone(&entry.session))
    }

    /// A model at a location that is not a local file, copied with its external data file (when there is one) to
    /// a temporary directory and loaded for this call, as the Groovy version did with every model.
    fn copied(ec: &ExecutionContext, location: &str) -> Result<Session, String> {
        let name = location
            .rsplit('/')
            .next()
            .filter(|name| !name.is_empty())
            .unwrap_or("model.onnx");
        let bytes = ec
            .factory()
            .resource()
            .get(location)
            .and_then(|resource| resource.read_bytes())
            .map_err(|error| error.to_string())?;
        let directory = std::env::temp_dir().join(format!(
            "moqui-onnx-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|time| time.as_nanos())
                .unwrap_or_default()
        ));
        std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
        let loaded = (|| {
            let model = directory.join(name);
            std::fs::write(&model, bytes).map_err(|error| error.to_string())?;
            let data_location = format!("{location}.data");
            if let Ok(data) = ec
                .factory()
                .resource()
                .get(&data_location)
                .and_then(|resource| resource.read_bytes())
            {
                std::fs::write(directory.join(format!("{name}.data")), data).map_err(|error| error.to_string())?;
            }
            load(&model)
        })();
        if let Err(error) = std::fs::remove_dir_all(&directory) {
            tracing::warn!("Could not delete the ONNX model copy {}: {error}", directory.display());
        }
        loaded
    }

    fn run(session: &mut Session, input: &[f32]) -> Result<(Vec<f32>, u64), String> {
        let input_name = session
            .inputs
            .first()
            .map(|input| input.name.clone())
            .ok_or_else(|| "the model has no input".to_string())?;
        let output_name = session
            .outputs
            .first()
            .map(|output| output.name.clone())
            .ok_or_else(|| "the model has no output".to_string())?;
        let tensor = Tensor::from_array(([1usize, input.len()], input.to_vec())).map_err(|error| error.to_string())?;
        let started = std::time::Instant::now();
        let outputs = session
            .run(ort::inputs![input_name => tensor])
            .map_err(|error| error.to_string())?;
        let latency = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
        let (_, values) = outputs
            .get(&output_name)
            .ok_or_else(|| "the model gave no output".to_string())?
            .try_extract_tensor::<f32>()
            .map_err(|error| error.to_string())?;
        Ok((values.to_vec(), latency))
    }

    pub(super) fn infer(
        sessions: &Sessions,
        ec: &ExecutionContext,
        location: &str,
        input: &[f32],
    ) -> Result<(Vec<f32>, u64), String> {
        if location.is_empty() {
            return Err("Missing ONNX content location.".into());
        }
        if std::env::var_os("ORT_DYLIB_PATH").is_none() {
            return Err("set ORT_DYLIB_PATH to the ONNX Runtime shared library (libonnxruntime)".into());
        }
        let resource = ec
            .factory()
            .resource()
            .get(location)
            .map_err(|error| format!("Could not resolve the ONNX model {location}: {error}"))?;
        match resource.file_path().filter(|path| path.is_file()) {
            Some(path) => {
                let session = cached(sessions, path)?;
                let mut session = session.lock().map_err(|_| "the ONNX session is poisoned".to_string())?;
                run(&mut session, input)
            }
            None => run(&mut copied(ec, location)?, input),
        }
    }
}

/// The factory of the tool, selected in MoquiConf.xml; it keeps the loaded models.
#[derive(Default)]
pub struct TrajectoryGeneratorFactory {
    sessions: Arc<Sessions>,
}

impl ToolFactory for TrajectoryGeneratorFactory {
    fn name(&self) -> &str {
        "TrajectoryGenerator"
    }

    fn get_instance(&self, _parameters: &[Value]) -> Result<Arc<dyn Tool>, Error> {
        if self.sessions.closed.load(Ordering::Acquire) {
            return Err(Error::new("The TrajectoryGenerator tool is shutting down."));
        }
        Ok(Arc::new(TrajectoryGenerator(Arc::clone(&self.sessions))))
    }

    fn destroy(&self) {
        self.sessions.closed.store(true, Ordering::Release);
        self.sessions.clear();
    }

    fn type_declaration(&self) -> Option<&'static str> {
        Some(
            "{ normalizePoseVector(value: unknown, fieldName: string): number[]; \
             normalizeNumberList(value: unknown, fieldName: string, minSize?: number | null): unknown[] | null; \
             imageBase64(location: string): string; \
             runInference(onnxContentLocation: string, startPose: number[], goalPose: number[]): \
             { waypoints: number[][]; waypointCount: number; inferenceLatencyMs: number }; \
             sessionCount(): number; loadCount(): number; clear(): void }",
        )
    }
}

struct TrajectoryGenerator(Arc<Sessions>);

impl Tool for TrajectoryGenerator {
    fn methods(&self) -> &'static [&'static str] {
        &[
            "normalizePoseVector",
            "normalizeNumberList",
            "imageBase64",
            "runInference",
            "sessionCount",
            "loadCount",
            "clear",
        ]
    }

    fn call(&self, ec: &ExecutionContext, method: &str, arguments: &[Value]) -> Result<Value, Error> {
        let argument = |index: usize| arguments.get(index).unwrap_or(&Value::Null);
        match method {
            "normalizePoseVector" => {
                let field_name = text_argument(arguments, 1, "fieldName")?;
                let pose = normalize_pose_vector(argument(0), field_name).map_err(Error::new)?;
                Ok(number_list(&pose))
            }
            "normalizeNumberList" => {
                let field_name = text_argument(arguments, 1, "fieldName")?;
                let min_size = size_argument(arguments.get(2))?;
                Ok(decimal_list(
                    normalize_number_list(argument(0), field_name, min_size).map_err(Error::new)?,
                ))
            }
            "imageBase64" => Ok(Value::String(image_base64(
                ec,
                text_argument(arguments, 0, "location")?,
            )?)),
            "runInference" => {
                let location = text_argument(arguments, 0, "onnxContentLocation")?;
                let start_pose = normalize_pose_vector(argument(1), "startPose").map_err(Error::new)?;
                let goal_pose = normalize_pose_vector(argument(2), "goalPose").map_err(Error::new)?;
                let (waypoints, latency) = self.0.run_inference(ec, location, &start_pose, &goal_pose)?;
                let count = waypoints.len();
                Ok(Value::Map(
                    [
                        (
                            "waypoints".to_string(),
                            Value::List(waypoints.iter().map(|pose| number_list(pose)).collect()),
                        ),
                        ("waypointCount".to_string(), Value::I64(count as i64)),
                        (
                            "inferenceLatencyMs".to_string(),
                            Value::I64(i64::try_from(latency).unwrap_or(i64::MAX)),
                        ),
                    ]
                    .into_iter()
                    .collect(),
                ))
            }
            "sessionCount" => Ok(Value::I64(self.0.count() as i64)),
            "loadCount" => Ok(Value::I64(self.0.loads.load(Ordering::Relaxed) as i64)),
            "clear" => {
                self.0.clear();
                Ok(Value::Null)
            }
            _ => Err(Error::new(format!(
                "The TrajectoryGenerator tool has no method {method}"
            ))),
        }
    }
}

#[cfg(test)]
#[path = "trajectory_tests.rs"]
mod tests;
