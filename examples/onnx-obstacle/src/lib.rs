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

// Shared inference implementation: this standalone crate does not link Moqui.
#[path = "../../../src/onnx_planner.rs"]
mod onnx_planner;
use anyhow::{bail, Context, Result};
pub use onnx_planner::*;
use std::path::Path;

impl Planner {
    pub fn configured() -> Result<Self> {
        match std::env::var("TRAJECTORY_ONNX_PROFILE")
            .as_deref()
            .unwrap_or("corridor13")
        {
            "corridor13" => Self::load(model_path()),
            "tcp12" => Self::load_tcp12(
                model_path(),
                std::env::var("TRAJECTORY_MODEL_ID").context("tcp12 requires TRAJECTORY_MODEL_ID")?,
            ),
            other => bail!("unsupported TRAJECTORY_ONNX_PROFILE: {other}"),
        }
    }
}

pub fn model_path() -> std::path::PathBuf {
    std::env::var_os("TRAJECTORY_ONNX_MODEL")
        .map(Into::into)
        .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("model.onnx"))
}

pub fn demo_request() -> PlanRequest {
    PlanRequest {
        math_model_id: MODEL_ID.into(),
        start_pose: [0.0; 6],
        goal_pose: [1.0, 0.0, 0.0, 0.0, 0.0, 0.0],
        obstacle: None,
    }
}

pub fn demo() -> Result<serde_json::Value> {
    let mut planner = Planner::load(model_path()).context("generate model.onnx with train.py first")?;
    let mut request = demo_request();
    let before = planner.plan(&request)?;
    request.obstacle = Some(serde_json::from_str(include_str!("../fixtures/obstacle.json"))?);
    let after = planner.plan(&request)?;
    if before.waypoints[5][1].abs() > 1e-5 || after.waypoints[5][1] < 0.19 {
        bail!("obstacle did not trigger the expected detour");
    }
    Ok(serde_json::json!({"before": before, "after": after, "obstacle":request.obstacle}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn supports_java_twelve_input_tensor_contract() -> Result<()> {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tcp12.onnx");
        let mut planner = Planner::load_tcp12(path, "LegacyTcp12".into())?;
        let mut request = demo_request();
        request.math_model_id = "LegacyTcp12".into();
        let response = planner.plan(&request)?;
        assert_eq!(response.waypoints.len(), 11);
        assert!(response.waypoints[5][1].abs() < 1e-5);
        request.obstacle = Some(serde_json::from_str(include_str!("../fixtures/obstacle.json"))?);
        assert!(planner.plan(&request).is_err());
        Ok(())
    }

    #[test]
    fn real_onnx_replans_and_checks_all_segments() -> Result<()> {
        let report = demo()?;
        let after: PlanResponse = serde_json::from_value(report["after"].clone())?;
        assert_eq!(after.waypoints.len(), 11);
        assert!((after.waypoints[5][1] - 0.20).abs() < 1e-5);
        Ok(())
    }

    #[test]
    fn rejects_unknown_models_and_unsupported_obstacles() -> Result<()> {
        let mut planner = Planner::load(model_path())?;
        let mut request = demo_request();
        request.math_model_id = "missing".into();
        assert!(planner.plan(&request).is_err());
        request.math_model_id = MODEL_ID.into();
        request.obstacle = Some(serde_json::from_str(include_str!("../fixtures/obstacle.json"))?);
        request.obstacle.as_mut().unwrap().coordinate_frame = "pixels".into();
        assert!(planner.plan(&request).is_err());
        request.obstacle.as_mut().unwrap().coordinate_frame = "demo-tcp-metres".into();
        request.obstacle.as_mut().unwrap().radius = 0.5;
        assert!(planner.plan(&request).is_err());
        request.obstacle = None;
        request.start_pose[0] = f32::NAN;
        assert!(planner.plan(&request).is_err());
        Ok(())
    }

    #[test]
    fn segment_check_detects_collision_between_waypoints() {
        let distance = segment_distance([0.0; 6], [1.0, 0.0, 0.0, 0.0, 0.0, 0.0], [0.5, 0.0, 0.0]);
        assert!(distance < 1e-6);
    }
}
