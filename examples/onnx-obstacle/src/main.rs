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

use axum::{Json, Router, extract::State, http::StatusCode, routing::post};
use moqui_onnx_obstacle_example::{PlanRequest, PlanResponse, Planner, demo};
use std::sync::{Arc, Mutex};

async fn plan(
    State(planner): State<Arc<Mutex<Planner>>>,
    Json(request): Json<PlanRequest>,
) -> Result<Json<PlanResponse>, (StatusCode, String)> {
    tokio::task::spawn_blocking(move || {
        planner
            .lock()
            .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "planner lock poisoned".into()))?
            .plan(&request)
            .map(Json)
            .map_err(|e| (StatusCode::UNPROCESSABLE_ENTITY, e.to_string()))
    })
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    if std::env::args().nth(1).as_deref() != Some("serve") {
        println!("{}", serde_json::to_string_pretty(&demo()?)?);
        return Ok(());
    }
    let planner = Arc::new(Mutex::new(Planner::configured()?));
    let app = Router::new().route("/plan", post(plan)).with_state(planner);
    // Intentionally loopback-only: this example is not an exposed production service.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:18092").await?;
    eprintln!("ONNX example listening on http://127.0.0.1:18092/plan");
    axum::serve(listener, app).await?;
    Ok(())
}
