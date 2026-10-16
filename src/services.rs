use moqui_core::context::ExecutionContext;
use moqui_core::native::{Parameters, ServiceInfo};
use moqui_lib::error::Error;

pub fn infer_trajectory_waypoints(
    ec: &ExecutionContext,
    _info: &ServiceInfo<'_>,
    parameters: &Parameters,
) -> Result<Parameters, Error> {
    #[cfg(not(feature = "onnx"))]
    {
        let _ = (ec, parameters);
        Err(Error::new(
            "Native ONNX is not enabled. Build with ./moq build --debug -- --features moqui-device/onnx and configure ORT_DYLIB_PATH, or explicitly select plannerMode=remote.",
        ))
    }
    #[cfg(feature = "onnx")]
    infer(ec, parameters)
        .map_err(|error| Error::new(format!("Native ONNX inference failed: {error:#}")))
}

#[cfg(feature = "onnx")]
fn infer(ec: &ExecutionContext, parameters: &Parameters) -> anyhow::Result<Parameters> {
    use crate::onnx_planner::{PlanRequest, Planner};
    use anyhow::{Context, bail, ensure};
    use moqui_lib::{json, object::Value};

    let model_id = parameters
        .get("mathModelId")
        .and_then(Value::as_str)
        .context("mathModelId is required")?;
    let entity = ec.factory().entity().context("entity facade unavailable")?;
    let model = entity
        .find("moqui.math.MathModel")?
        .eq("mathModelId", Value::string(model_id))
        .one()?
        .context("MathModel not found")?;
    let definition = model
        .get("mathModelDefId")
        .cloned()
        .context("MathModel has no definition")?;
    let content = entity
        .find("moqui.math.MathModelDefContent")?
        .eq("mathModelDefId", definition)
        .eq("contentTypeEnumId", Value::string("MmCntOnnx"))
        .one()?
        .context("ONNX content not found")?;
    let location = content
        .get("contentLocation")
        .and_then(Value::as_str)
        .context("ONNX contentLocation is missing")?;
    // Only the model's registered artifact is loaded; callers cannot supply a path.
    let resource = ec.factory().resource().get(location)?;
    let path = resource.file_path().context(
        "Native ONNX requires a local/component file; materialize remote/DB model content first",
    )?;
    ensure!(path.is_file(), "ONNX model file does not exist: {location}");
    let profile = parameters
        .get("onnxProfile")
        .and_then(Value::as_str)
        .unwrap_or("tcp12");
    let runtime_library = std::env::var_os("ORT_DYLIB_PATH")
        .context("Set ORT_DYLIB_PATH to the installed ONNX Runtime shared library")?;
    ensure!(
        std::path::Path::new(&runtime_library).is_file(),
        "ORT_DYLIB_PATH does not name an existing library file"
    );
    let mut planner = match profile {
        "tcp12" => Planner::load_tcp12(path, model_id.into())?,
        "corridor13" => Planner::load(path)?,
        _ => bail!("onnxProfile must be tcp12 or corridor13"),
    };
    let required = |key: &str| {
        parameters
            .get(key)
            .map(json::to_json)
            .with_context(|| format!("{key} is required"))
    };
    let request: PlanRequest = serde_json::from_value(serde_json::json!({
        "mathModelId": model_id, "startPose": required("startPose")?, "goalPose": required("goalPose")?,
        "obstacle": parameters.get("obstacle").map(json::to_json),
    }))?;
    let response = planner.plan(&request)?;
    let mut out = Parameters::new();
    out.insert(
        "waypoints".into(),
        Value::List(
            response
                .waypoints
                .into_iter()
                .map(|pose| {
                    Value::List(
                        pose.into_iter()
                            .map(|value| Value::F64(f64::from(value)))
                            .collect(),
                    )
                })
                .collect(),
        ),
    );
    Ok(out)
}
