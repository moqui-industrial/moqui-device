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

//! Native Moqui device services. ONNX inference is an optional build feature.
#[cfg(feature = "onnx")]
mod onnx_planner;
mod onnx_tool;
mod services;

use moqui_core::context::Error;
use moqui_core::native::{submit_component, NativeComponent, NativeRegistry};

submit_component! { NativeComponent { name: "moqui-device", register } }

fn register(registry: &mut NativeRegistry) -> Result<(), Error> {
    registry.tool("moqui_device::OnnxToolFactory", || {
        std::sync::Arc::new(onnx_tool::OnnxToolFactory::default())
    })?;
    registry.service_function(
        "moqui_device::services::infer_trajectory_waypoints",
        services::infer_trajectory_waypoints,
    )
}
