use anyhow::{Context, Result, ensure};
use ort::{session::Session, value::Tensor};
use serde::{Deserialize, Serialize};
use std::path::Path;

pub const MODEL_ID: &str = "DemoObstacleCorridorV1";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Obstacle {
    pub center: [f32; 3],
    pub radius: f32,
    pub margin: f32,
    pub coordinate_frame: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanRequest {
    pub math_model_id: String,
    pub start_pose: [f32; 6],
    pub goal_pose: [f32; 6],
    pub obstacle: Option<Obstacle>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct PlanResponse {
    pub waypoints: Vec<[f32; 6]>,
}

pub struct Planner {
    session: Session,
    model_id: String,
    tcp12: bool,
}

impl Planner {
    pub fn load(path: impl AsRef<Path>) -> Result<Self> {
        let session = Session::builder()?
            .with_intra_threads(1)?
            .commit_from_file(path)?;
        ensure!(
            session.inputs.len() == 1 && !session.outputs.is_empty(),
            "expected one model input and at least one output"
        );
        Ok(Self {
            session,
            model_id: MODEL_ID.into(),
            tcp12: false,
        })
    }

    /// Java/DJL contract: one float input [1,12], first output flattened into TCP poses.
    pub fn load_tcp12(path: impl AsRef<Path>, model_id: String) -> Result<Self> {
        let mut planner = Self::load(path)?;
        ensure!(
            planner.session.inputs.len() == 1,
            "tcp12 expects one model input"
        );
        ensure!(!model_id.is_empty(), "model ID must not be empty");
        planner.model_id = model_id;
        planner.tcp12 = true;
        Ok(planner)
    }

    pub fn plan(&mut self, request: &PlanRequest) -> Result<PlanResponse> {
        ensure!(
            request.math_model_id == self.model_id,
            "unknown model; expected {}",
            self.model_id
        );
        ensure!(
            request
                .start_pose
                .iter()
                .chain(&request.goal_pose)
                .all(|v| v.is_finite()),
            "non-finite pose"
        );
        let mut clearance = 0.0;
        if let Some(obstacle) = &request.obstacle {
            ensure!(
                !self.tcp12,
                "the 12-input model does not support obstacle observations"
            );
            // Explicit domain of the demonstration: a calibrated, fixed X corridor.
            ensure!(
                request.start_pose == [0.0; 6]
                    && request.goal_pose == [1.0, 0.0, 0.0, 0.0, 0.0, 0.0],
                "obstacle demo requires the unit X corridor"
            );
            ensure!(
                obstacle.coordinate_frame == "demo-tcp-metres",
                "uncalibrated obstacle coordinate frame"
            );
            ensure!(
                obstacle.center == [0.5, 0.0, 0.0],
                "obstacle demo requires a centered sphere"
            );
            ensure!(
                obstacle.radius.is_finite()
                    && obstacle.radius > 0.0
                    && obstacle.margin.is_finite()
                    && obstacle.margin > 0.0,
                "invalid obstacle radius/margin"
            );
            clearance = obstacle.radius + obstacle.margin;
            ensure!(clearance <= 0.25, "obstacle exceeds demonstration corridor");
        }
        let mut features: Vec<f32> = request
            .start_pose
            .iter()
            .chain(&request.goal_pose)
            .copied()
            .collect();
        if !self.tcp12 {
            features.push(clearance);
        }
        let input_width = features.len();
        let input_name = if self.tcp12 {
            self.session.inputs[0].name.clone()
        } else {
            "features".into()
        };
        let output_name = if self.tcp12 {
            self.session.outputs[0].name.clone()
        } else {
            "waypoints".into()
        };
        let outputs = self.session.run(
            ort::inputs![input_name => Tensor::from_array(([1usize, input_width], features))?],
        )?;
        let (shape, values) = outputs
            .get(&output_name)
            .context("model has no waypoints output")?
            .try_extract_tensor::<f32>()?;
        ensure!(
            self.tcp12 || shape.as_ref() == [1, 66],
            "wrong model output shape: {shape:?}"
        );
        ensure!(
            values.iter().all(|v| v.is_finite()),
            "model produced non-finite coordinates"
        );
        ensure!(
            values.len() >= 12 && values.len() % 6 == 0,
            "output must contain at least two complete TCP poses"
        );
        let waypoints: Vec<[f32; 6]> = values.as_chunks::<6>().0.to_vec();
        if self.tcp12 {
            return Ok(PlanResponse { waypoints });
        }
        ensure!(waypoints.len() == 11, "wrong waypoint count");
        for (actual, expected) in [
            (&waypoints[0], &request.start_pose),
            (&waypoints[10], &request.goal_pose),
        ] {
            ensure!(
                actual
                    .iter()
                    .zip(expected)
                    .all(|(a, b)| (a - b).abs() < 1e-5),
                "model changed an endpoint"
            );
        }
        if let Some(obstacle) = &request.obstacle {
            for segment in waypoints.windows(2) {
                ensure!(
                    segment_distance(segment[0], segment[1], obstacle.center) + 1e-5
                        >= obstacle.radius + obstacle.margin,
                    "model path intersects obstacle clearance sphere"
                );
            }
        }
        Ok(PlanResponse { waypoints })
    }
}

/// Checks entire straight segments, not just sampled waypoints (point robot only).
pub fn segment_distance(a: [f32; 6], b: [f32; 6], center: [f32; 3]) -> f32 {
    let delta: Vec<_> = (0..3).map(|i| b[i] - a[i]).collect();
    let length2: f32 = delta.iter().map(|v| v * v).sum();
    let t = if length2 > 0.0 {
        ((0..3).map(|i| (center[i] - a[i]) * delta[i]).sum::<f32>() / length2).clamp(0.0, 1.0)
    } else {
        0.0
    };
    (0..3)
        .map(|i| (a[i] + t * delta[i] - center[i]).powi(2))
        .sum::<f32>()
        .sqrt()
}
