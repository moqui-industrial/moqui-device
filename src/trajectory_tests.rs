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

use super::*;

fn pose(values: &[Value]) -> Value {
    Value::List(values.to_vec())
}

#[test]
fn a_pose_takes_numbers_and_texts_of_numbers() {
    let value = pose(&[
        Value::I64(1),
        Value::F64(2.5),
        Value::string(" 3 "),
        Value::I32(-4),
        Value::Decimal("5.25".parse().unwrap()),
        Value::string("6e-1"),
    ]);
    assert_eq!(
        normalize_pose_vector(&value, "startPose").unwrap(),
        vec![1.0, 2.5, 3.0, -4.0, 5.25, 0.6]
    );
}

#[test]
fn a_pose_refuses_what_the_groovy_class_refused() {
    let six = |last: Value| {
        pose(&[
            Value::I64(0),
            Value::I64(0),
            Value::I64(0),
            Value::I64(0),
            Value::I64(0),
            last,
        ])
    };
    assert_eq!(
        normalize_pose_vector(&Value::string("1,2"), "goalPose").unwrap_err(),
        "goalPose must be a List with exactly 6 numeric values."
    );
    assert_eq!(
        normalize_pose_vector(&pose(&[Value::I64(1)]), "goalPose").unwrap_err(),
        "goalPose must contain exactly 6 numeric values, found 1."
    );
    assert_eq!(
        normalize_pose_vector(&six(Value::string("  ")), "goalPose").unwrap_err(),
        "goalPose[5] must not be empty."
    );
    assert_eq!(
        normalize_pose_vector(&six(Value::string("x")), "goalPose").unwrap_err(),
        "goalPose[5] must be numeric, found value 'x'."
    );
    assert_eq!(
        normalize_pose_vector(&six(Value::Null), "goalPose").unwrap_err(),
        "goalPose[5] must be numeric, found null."
    );
}

#[test]
fn a_number_list_keeps_null_wraps_a_single_value_and_counts_its_values() {
    assert_eq!(normalize_number_list(&Value::Null, "center", Some(2)).unwrap(), None);
    let single = normalize_number_list(&Value::F64(0.5), "confidence", None)
        .unwrap()
        .unwrap();
    assert_eq!(single.len(), 1);
    assert_eq!(single[0].to_string(), "0.5");
    let list = normalize_number_list(&pose(&[Value::string("10"), Value::I64(20)]), "center", Some(2))
        .unwrap()
        .unwrap();
    assert_eq!(list.iter().map(ToString::to_string).collect::<Vec<_>>(), ["10", "20"]);
    assert_eq!(
        normalize_number_list(&pose(&[Value::I64(1)]), "boundingBox", Some(4)).unwrap_err(),
        "boundingBox must contain at least 4 values."
    );
    assert_eq!(
        normalize_number_list(&pose(&[Value::I64(1), Value::Null]), "center", None).unwrap_err(),
        "center[1] is empty."
    );
}

#[test]
fn the_model_output_is_split_into_six_value_waypoints() {
    let output: Vec<f32> = (0..12).map(|value| value as f32).collect();
    let poses = waypoints(&output).unwrap();
    assert_eq!(poses.len(), 2);
    assert_eq!(poses[1], vec![6.0, 7.0, 8.0, 9.0, 10.0, 11.0]);
    assert_eq!(
        waypoints(&[]).unwrap_err(),
        "Trajectory inference returned an empty output tensor."
    );
    assert_eq!(
        waypoints(&[1.0; 7]).unwrap_err(),
        "Trajectory inference returned 7 values, not divisible by 6 TCP pose components."
    );
}

#[test]
fn the_model_input_is_the_start_pose_then_the_goal_pose() {
    let input = model_input(&[1.0, 2.0, 3.0, 4.0, 5.0, 6.0], &[7.0, 8.0, 9.0, 10.0, 11.0, 12.0]);
    assert_eq!(input, (1..=12).map(|value| value as f32).collect::<Vec<_>>());
}
