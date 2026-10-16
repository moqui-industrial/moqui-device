//! Factory-owned ONNX sessions. One mutable session per artifact, shared by services/tools.
use moqui_core::context::Error;
use moqui_core::native::{Tool, ToolFactory};
use moqui_lib::object::Value;
#[cfg(feature = "onnx")]
use std::collections::HashMap;
#[cfg(feature = "onnx")]
use std::sync::Mutex;
use std::sync::{
    Arc,
    atomic::{AtomicBool, AtomicU64, Ordering},
};

#[cfg(feature = "onnx")]
use crate::onnx_planner::{PlanRequest, PlanResponse, Planner};

#[cfg(feature = "onnx")]
struct Entry {
    fingerprint: String,
    planner: Arc<Mutex<Planner>>,
    used: u64,
}

#[derive(Default)]
pub struct Sessions {
    closed: AtomicBool,
    loads: AtomicU64,
    #[cfg(feature = "onnx")]
    clock: AtomicU64,
    #[cfg(feature = "onnx")]
    entries: Mutex<HashMap<(String, String), Entry>>,
}

impl Sessions {
    #[cfg(feature = "onnx")]
    pub fn plan(
        &self,
        path: &std::path::Path,
        profile: &str,
        revision: &str,
        request: &PlanRequest,
    ) -> anyhow::Result<PlanResponse> {
        use anyhow::{Context, bail, ensure};
        let metadata = std::fs::metadata(path)?;
        let external = std::fs::metadata(format!("{}.data", path.display()))
            .ok()
            .map(|metadata| (metadata.modified().ok(), metadata.len()));
        let fingerprint = format!(
            "{}:{:?}:{}:{revision}:{external:?}",
            path.canonicalize()?.display(),
            metadata.modified()?,
            metadata.len()
        );
        let key = (request.math_model_id.clone(), profile.to_string());
        let planner = {
            let mut entries = self
                .entries
                .lock()
                .map_err(|_| anyhow::anyhow!("ONNX registry lock poisoned"))?;
            ensure!(
                !self.closed.load(Ordering::Acquire),
                "ONNX factory is shutting down"
            );
            if !entries
                .get(&key)
                .is_some_and(|entry| entry.fingerprint == fingerprint)
            {
                let planner = match profile {
                    "tcp12" => Planner::load_tcp12(path, request.math_model_id.clone())?,
                    "corridor13" => Planner::load(path)?,
                    _ => bail!("onnxProfile must be tcp12 or corridor13"),
                };
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
                        planner: Arc::new(Mutex::new(planner)),
                        used: 0,
                    },
                );
                self.loads.fetch_add(1, Ordering::Relaxed);
            }
            let entry = entries
                .get_mut(&key)
                .context("ONNX session not registered")?;
            entry.used = self.clock.fetch_add(1, Ordering::Relaxed);
            entry.planner.clone()
        };
        // ort::Session::run requires exclusive access. Other models have independent locks.
        let mut planner = planner
            .lock()
            .map_err(|_| anyhow::anyhow!("ONNX session lock poisoned"))?;
        planner.plan(request)
    }

    fn clear(&self, model: Option<&str>) {
        #[cfg(feature = "onnx")]
        if let Ok(mut entries) = self.entries.lock() {
            entries.retain(|(id, _), _| model.is_some_and(|model| model != id));
        }
        #[cfg(not(feature = "onnx"))]
        let _ = model;
    }

    fn count(&self) -> usize {
        #[cfg(feature = "onnx")]
        {
            self.entries
                .lock()
                .map(|entries| entries.len())
                .unwrap_or(0)
        }
        #[cfg(not(feature = "onnx"))]
        {
            0
        }
    }
}

#[derive(Default)]
pub struct OnnxToolFactory {
    pub(crate) sessions: Arc<Sessions>,
}

impl ToolFactory for OnnxToolFactory {
    fn name(&self) -> &str {
        "Onnx"
    }
    fn get_instance(&self, _parameters: &[Value]) -> Result<Arc<dyn Tool>, Error> {
        if self.sessions.closed.load(Ordering::Acquire) {
            return Err(Error::new("ONNX factory is shutting down"));
        }
        Ok(Arc::new(OnnxManager(self.sessions.clone())))
    }
    fn destroy(&self) {
        self.sessions.closed.store(true, Ordering::Release);
        self.sessions.clear(None);
    }
    fn type_declaration(&self) -> Option<&'static str> {
        Some(
            "{ invalidate(mathModelId: string): void; clear(): void; sessionCount(): number; loadCount(): number }",
        )
    }
}

struct OnnxManager(Arc<Sessions>);
impl Tool for OnnxManager {
    fn methods(&self) -> &'static [&'static str] {
        &["invalidate", "clear", "sessionCount", "loadCount"]
    }
    fn call(
        &self,
        _ec: &moqui_core::context::ExecutionContext,
        method: &str,
        args: &[Value],
    ) -> Result<Value, Error> {
        match method {
            "invalidate" => {
                let id = args
                    .first()
                    .and_then(Value::as_str)
                    .ok_or_else(|| Error::new("mathModelId is required"))?;
                self.0.clear(Some(id));
                Ok(Value::Null)
            }
            "clear" => {
                self.0.clear(None);
                Ok(Value::Null)
            }
            "sessionCount" => Ok(Value::I64(self.0.count() as i64)),
            "loadCount" => Ok(Value::I64(self.0.loads.load(Ordering::Relaxed) as i64)),
            _ => Err(Error::new("Unknown ONNX tool method")),
        }
    }
}
