# This software is in the public domain under CC0 1.0 Universal plus a
# Grant of Patent License.
#
# To the extent possible under law, the author(s) have dedicated all
# copyright and related and neighboring rights to this software to the
# public domain worldwide. This software is distributed without any
# warranty.
#
# You should have received a copy of the CC0 Public Domain Dedication
# along with this software (see the LICENSE.md file). If not, see
# <http://creativecommons.org/publicdomain/zero/1.0/>.

"""Train/export a small reproducible ReLU waypoint network; no PyTorch needed.

Input: start TCP (6), goal TCP (6), positive-Y detour clearance (1).
Output: eleven TCP poses. Targets describe a deliberately narrow demo corridor.
The hidden feature layer is fixed; the output layer is fitted by least squares.
This demonstrates real ONNX inference, not general robot motion planning.
"""
from pathlib import Path
import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper

rng = np.random.default_rng(20261016)
x = rng.uniform(-1, 1, (2048, 13))
x[:, 12] = rng.uniform(0, 0.25, len(x))
x[::4, 12] = 0
t = np.linspace(0, 1, 11)
bump = np.minimum(np.minimum(4 * t, 1), 4 * (1 - t))
y = x[:, None, :6] * (1 - t[None, :, None]) + x[:, None, 6:12] * t[None, :, None]
y[:, :, 1] += x[:, 12, None] * bump
w1 = np.concatenate([np.eye(13), -np.eye(13)], axis=1)
h = np.maximum(x @ w1, 0)
w2 = np.linalg.lstsq(h, y.reshape(-1, 66), rcond=None)[0]
error = float(np.max(np.abs(h @ w2 - y.reshape(-1, 66))))
assert error < 1e-6, error
graph = helper.make_graph([
    helper.make_node("MatMul", ["features", "w1"], ["hidden_linear"]),
    helper.make_node("Relu", ["hidden_linear"], ["hidden"]),
    helper.make_node("MatMul", ["hidden", "w2"], ["waypoints"]),
], "demo_corridor_waypoint_mlp", [helper.make_tensor_value_info("features", TensorProto.FLOAT, [1, 13])],
    [helper.make_tensor_value_info("waypoints", TensorProto.FLOAT, [1, 66])],
    [numpy_helper.from_array(w1.astype(np.float32), "w1"), numpy_helper.from_array(w2.astype(np.float32), "w2")])
model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 17)],
                          producer_name="moqui-device isolated corridor example", ir_version=9)
onnx.checker.check_model(model)
path = Path(__file__).with_name("model.onnx")
onnx.save(model, path)
print(f"Saved {path}: ReLU 13->26->66, training max error {error:.3g}")

# A second fixture exercises the original Java/DJL 12-input contract.
graph.input[0].type.tensor_type.shape.dim[1].dim_value = 12
graph.initializer[0].CopyFrom(numpy_helper.from_array(w1[:12].astype(np.float32), "w1"))
legacy = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 17)], ir_version=9)
onnx.checker.check_model(legacy)
onnx.save(legacy, path.with_name("tcp12.onnx"))
