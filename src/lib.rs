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

//! Native code of moqui-device: the sample store services, the restart of subscriptions, the file of a DeviceContent,
//! and the trajectory generator tool of the robot arm planner (ONNX inference is the optional `onnx` feature). The
//! drivers are not here: a DeviceRequest names the service that runs it.
mod content;
mod inbound;
mod restoration;
mod trajectory;

use moqui_core::context::Error;
use moqui_core::native::{submit_component, NativeComponent, NativeRegistry};

submit_component! { NativeComponent { name: "moqui-device", register } }

fn register(registry: &mut NativeRegistry) -> Result<(), Error> {
    registry.tool("moqui_device::TrajectoryGeneratorFactory", || {
        std::sync::Arc::new(trajectory::TrajectoryGeneratorFactory::default())
    })?;
    registry.tool("moqui_device::DeviceSubscriptionsFactory", || {
        std::sync::Arc::new(restoration::DeviceSubscriptionsFactory::default())
    })?;
    registry.service_function("moqui_device::restoration::start", restoration::start)?;
    registry.service_function("moqui_device::restoration::record", restoration::record)?;
    registry.service_function("moqui_device::inbound::store_samples", inbound::store_samples)?;
    registry.service_function("moqui_device::content::transfer_files", content::transfer_files)
}
