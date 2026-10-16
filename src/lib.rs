//! Native Moqui device services. ONNX inference is an optional build feature.
#[cfg(feature = "onnx")]
mod onnx_planner;
mod services;

use moqui_core::context::Error;
use moqui_core::native::{NativeComponent, NativeRegistry, submit_component};

submit_component! { NativeComponent { name: "moqui-device", register } }

fn register(registry: &mut NativeRegistry) -> Result<(), Error> {
    registry.service_function(
        "moqui_device::services::infer_trajectory_waypoints",
        services::infer_trajectory_waypoints,
    )
}
