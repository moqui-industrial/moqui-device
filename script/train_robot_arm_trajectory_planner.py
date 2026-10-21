"""
6-DOF TCP Waypoint Planner — Training & ONNX Export
===================================================

Trains a 3-layer MLP on synthetic TCP waypoint trajectories and exports
the trained model to ONNX format for use with the moqui-device
run#RobotArmTrajectoryPlanner service.

The generated waypoints live in the same 6D TCP pose space expected by
the PLC side:
    [X, Y, Z, A, B, C]

The synthetic dataset is intentionally obstacle-like: between start and goal
poses the generator injects a smooth Cartesian detour on XYZ, while A/B/C are
interpolated smoothly. This gives the neural net examples closer to "avoid an
obstacle and then rejoin the nominal path" rather than plain straight-line
interpolation.
"""

import os
import numpy as np
import torch
import torch.nn as nn
import torch.optim as optim

# Configuration

N_DIMS = 6
N_WAYPOINTS = int(os.environ.get("TRAJECTORY_WAYPOINTS", "10"))
N_OUT = N_WAYPOINTS * N_DIMS

# TCP pose ranges: X/Y/Z in mm, A/B/C in degrees
POSE_LIMITS = np.array([
    [200.0, 1200.0],   # X
    [-800.0, 800.0],   # Y
    [100.0, 1600.0],   # Z
    [-180.0, 180.0],   # A
    [-180.0, 180.0],   # B
    [-180.0, 180.0],   # C
], dtype=np.float32)

N_TRAIN = int(os.environ.get("TRAJECTORY_TRAIN_SAMPLES", "50000"))
N_VAL = int(os.environ.get("TRAJECTORY_VAL_SAMPLES", "5000"))
BATCH = int(os.environ.get("TRAJECTORY_BATCH_SIZE", "512"))
EPOCHS = int(os.environ.get("TRAJECTORY_EPOCHS", "80"))
LR = float(os.environ.get("TRAJECTORY_LR", "1e-3"))

OUT_DIR  = os.path.join(os.path.dirname(__file__), "..", "data", "ml")
OUT_PATH = os.path.join(OUT_DIR, "trajectory_planner.onnx")

# Synthetic data generation

def _quintic_progress(t: np.ndarray) -> np.ndarray:
    return 6 * t**5 - 15 * t**4 + 10 * t**3


def _sample_pose(n: int) -> np.ndarray:
    lo = POSE_LIMITS[:, 0]
    hi = POSE_LIMITS[:, 1]
    return np.random.uniform(lo, hi, (n, N_DIMS)).astype(np.float32)


def _bounded_obstacle_offset(start_xyz: np.ndarray, goal_xyz: np.ndarray) -> np.ndarray:
    delta = goal_xyz - start_xyz
    norm = np.linalg.norm(delta)
    if norm < 1e-6:
        return np.array([0.0, 0.0, 0.0], dtype=np.float32)

    direction = delta / norm
    reference = np.array([0.0, 0.0, 1.0], dtype=np.float32)
    if abs(np.dot(direction, reference)) > 0.95:
        reference = np.array([0.0, 1.0, 0.0], dtype=np.float32)

    lateral = np.cross(direction, reference)
    lateral_norm = np.linalg.norm(lateral)
    if lateral_norm < 1e-6:
        lateral = np.array([1.0, 0.0, 0.0], dtype=np.float32)
        lateral_norm = 1.0
    lateral = lateral / lateral_norm

    vertical = np.cross(direction, lateral)
    vertical = vertical / max(np.linalg.norm(vertical), 1e-6)

    amplitude = min(max(norm * np.random.uniform(0.08, 0.22), 20.0), 250.0)
    return amplitude * (
        np.random.uniform(-1.0, 1.0) * lateral +
        np.random.uniform(0.2, 1.0) * vertical
    )


def tcp_waypoints(start_pose: np.ndarray, goal_pose: np.ndarray, n_waypoints: int) -> np.ndarray:
    """
    Generate a smooth TCP trajectory with a synthetic XYZ detour and
    quintic orientation interpolation.
    """
    t = np.linspace(0.0, 1.0, n_waypoints, dtype=np.float32)
    s = _quintic_progress(t).astype(np.float32)
    bell = (16.0 * (t**2) * ((1.0 - t) ** 2)).astype(np.float32)

    start_xyz = start_pose[:3]
    goal_xyz = goal_pose[:3]
    start_abc = start_pose[3:]
    goal_abc = goal_pose[3:]

    xyz = start_xyz[None, :] + s[:, None] * (goal_xyz - start_xyz)[None, :]
    xyz += bell[:, None] * _bounded_obstacle_offset(start_xyz, goal_xyz)[None, :]

    abc = start_abc[None, :] + s[:, None] * (goal_abc - start_abc)[None, :]
    waypoints = np.concatenate([xyz, abc], axis=1)
    return waypoints.astype(np.float32)


def generate_dataset(n: int):
    pose_start = _sample_pose(n)
    pose_goal = _sample_pose(n)
    targets = np.array([
        tcp_waypoints(pose_start[i], pose_goal[i], N_WAYPOINTS).flatten()
        for i in range(n)
    ], dtype=np.float32)
    inputs = np.concatenate([pose_start, pose_goal], axis=1)
    return inputs, targets


# Model

class TrajectoryMLP(nn.Module):
    def __init__(self):
        super().__init__()
        self.net = nn.Sequential(
            nn.Linear(12, 128),
            nn.ReLU(),
            nn.Linear(128, 256),
            nn.ReLU(),
            nn.Linear(256, N_OUT),
        )

    def forward(self, x):
        return self.net(x)


# Training loop

def train():
    print("Generating synthetic TCP waypoint data …")
    X_train, y_train = generate_dataset(N_TRAIN)
    X_val, y_val = generate_dataset(N_VAL)

    X_train_t = torch.from_numpy(X_train)
    y_train_t = torch.from_numpy(y_train)
    X_val_t = torch.from_numpy(X_val)
    y_val_t = torch.from_numpy(y_val)

    dataset = torch.utils.data.TensorDataset(X_train_t, y_train_t)
    loader = torch.utils.data.DataLoader(dataset, batch_size=BATCH, shuffle=True)

    model = TrajectoryMLP()
    opt = optim.Adam(model.parameters(), lr=LR)
    loss_fn = nn.MSELoss()

    print(f"Training {N_TRAIN} samples, {EPOCHS} epochs …")
    for epoch in range(1, EPOCHS + 1):
        model.train()
        total_loss = 0.0
        for xb, yb in loader:
            pred = model(xb)
            loss = loss_fn(pred, yb)
            opt.zero_grad()
            loss.backward()
            opt.step()
            total_loss += loss.item() * len(xb)

        if epoch % 10 == 0 or epoch == 1:
            model.eval()
            with torch.no_grad():
                val_loss = loss_fn(model(X_val_t), y_val_t).item()
            rmse = np.sqrt(total_loss / N_TRAIN)
            print(f"  epoch {epoch:3d}/{EPOCHS}  train-RMSE={rmse:.4f}  val-MSE={val_loss:.4f}")

    return model


# ONNX export

def _ensure_onnxscript():
    """PyTorch >= 2.5 requires onnxscript even for the legacy exporter path."""
    try:
        import onnxscript  # noqa: F401
    except ModuleNotFoundError:
        import subprocess, sys
        print("Installing onnxscript (required by this PyTorch version) …")
        subprocess.check_call([sys.executable, "-m", "pip", "install", "onnxscript"])


def export_onnx(model: nn.Module):
    _ensure_onnxscript()
    os.makedirs(OUT_DIR, exist_ok=True)
    model.eval()
    dummy = torch.zeros(1, 12, dtype=torch.float32)
    torch.onnx.export(model, dummy, OUT_PATH, input_names=["input"], output_names=["waypoints"],
        dynamic_axes={"input": {0: "batch"}, "waypoints": {0: "batch"}}, opset_version=17)
    # PyTorch 2.x may export as external data ({name}.onnx + {name}.onnx.data).
    # Consolidate into a single self-contained file, loadable from any path (Rust/ort, Java/DJL).
    data_file = OUT_PATH + ".data"
    if os.path.exists(data_file):
        import onnx as _onnx
        print("External data detected — consolidating into single-file ONNX …")
        model_proto = _onnx.load(OUT_PATH)   # loads graph + external weights
        os.remove(OUT_PATH)
        os.remove(data_file)
        _onnx.save(model_proto, OUT_PATH)    # embeds all tensors inline
    size_kb = os.path.getsize(OUT_PATH) / 1024
    print(f"Exported → {OUT_PATH}  ({size_kb:.1f} KB)")


# Main

if __name__ == "__main__":
    np.random.seed(42)
    torch.manual_seed(42)
    model = train()
    export_onnx(model)
    print("Done. Start moqui and call run#RobotArmTrajectoryPlanner with mathModelId=TrjPlannerMlp6DofV1.")
