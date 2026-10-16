// MR-Moqui component regression tests. Optional HTTP contract checks use
// gateway_test_url pointing at a local fixture server (see test/README.md).
spec({
    setup() { ec.artifactExecution.disableAuthz(); },
    cleanup() { ec.artifactExecution.enableAuthz(); },
});

feature("native Rust ONNX service replans and persists without an HTTP provider", {
    ignore: !System.getProperty("trajectory_native_test"),
    when() {
        const parameters = {mathModelId:"DemoObstacleCorridorV1", onnxProfile:"corridor13",
            startPose:[0,0,0,0,0,0], goalPose:[1,0,0,0,0,0]};
        const before = call("moqui.device.TrajectoryPlannerServices.run#RobotArmTrajectoryPlanner",parameters);
        parameters.obstacle = {center:[0.5,0,0], radius:0.12, margin:0.08, coordinateFrame:"demo-tcp-metres"};
        const after = call("moqui.device.TrajectoryPlannerServices.run#RobotArmTrajectoryPlanner",parameters);
        const middleY = (id) => {
            const sample = ec.entity.find("moqui.math.ApproximatedFunctionSample").condition("approximatedFunctionId",id).condition("sampleCode","WP0005").one();
            return ec.entity.find("moqui.math.VectorComponent").condition("vectorId",sample.sampleVectorId).condition("dimensionIndex",1).one().realValue.toNumber();
        };
        return {beforeY:middleY(before.approximatedFunctionId), afterY:middleY(after.approximatedFunctionId),
            run:ec.entity.find("moqui.math.MathModelRun").condition("mathModelRunId",after.mathModelRunId).one()};
    },
    then(out) {
        Math.abs(out.beforeY) < 0.00001;
        Math.abs(out.afterY - 0.20) < 0.00001;
        JSON.parse(out.run.parameters).plannerMode == "native";
        out.run.hasError == "N";
    },
});

feature("native Rust ONNX service accepts the Java twelve-input contract", {
    ignore: !System.getProperty("trajectory_native_test"),
    when() {
        return call("moqui.device.OnnxServices.infer#TrajectoryWaypoints", {
            mathModelId:"DemoTcp12V1", startPose:[0,0,0,0,0,0], goalPose:[1,0,0,0,0,0],
        });
    },
    then(out) {
        out.waypoints.length == 11;
        Math.abs(out.waypoints[5][0] - 0.5) < 0.00001;
    },
});

feature("native Rust ONNX factory reuses and explicitly invalidates model sessions", {
    ignore: !System.getProperty("trajectory_native_test"),
    when() {
        const tool = ec.getTool("Onnx");
        tool.clear();
        const startLoads = tool.loadCount();
        const parameters = {mathModelId:"DemoTcp12V1", startPose:[0,0,0,0,0,0], goalPose:[1,0,0,0,0,0]};
        call("moqui.device.OnnxServices.infer#TrajectoryWaypoints",parameters);
        call("moqui.device.OnnxServices.infer#TrajectoryWaypoints",parameters);
        const reusedLoads = tool.loadCount() - startLoads;
        const reusedCount = tool.sessionCount();
        tool.invalidate("DemoTcp12V1");
        call("moqui.device.OnnxServices.infer#TrajectoryWaypoints",parameters);
        const afterLoads=tool.loadCount()-startLoads;
        call("update#moqui.math.MathModelDefContent", {mathModelDefContentId:"DemoTcp12Onnx",contentDate:"2002-01-01 00:00:00"});
        try {
            call("moqui.device.OnnxServices.infer#TrajectoryWaypoints",parameters);
            return {reusedLoads,reusedCount,afterLoads,revisionLoads:tool.loadCount()-startLoads};
        } finally {
            call("update#moqui.math.MathModelDefContent", {mathModelDefContentId:"DemoTcp12Onnx",contentDate:null});
        }
    },
    then(out) { out.reusedLoads == 1; out.reusedCount == 1; out.afterLoads == 2; out.revisionLoads == 3; },
});

feature("the canonical gateway scenario and HVAC whitelist load", {
    when() {
        return {
            gateway: ec.entity.find("moqui.device.PhysicalDevice").condition("deviceId", "GW_EDGE_01").one(),
            items: ec.entity.find("moqui.device.DeviceRequestItem").condition("requestName", "HVAC_DEMO_LiveParametersWrite").count(),
            parameter: ec.entity.find("moqui.math.Parameter").condition("parameterId", "TestPlcReferenceParam").one(),
        };
    },
    then(out) {
        out.gateway != null;
        out.items == 20;
        out.parameter.numericValue == 300;
    },
});

feature("configuration dry run preserves device values", {
    when() {
        const before = ec.entity.find("moqui.math.Parameter").condition("parameterId", "TestPlcReferenceParam").one().numericValue;
        const output = call("moqui.device.DeviceServices.apply#DeviceConfig", {
            deviceId: "VIRTUAL_PLC_01", deviceConfigId: "TestPlcGatewayConfig1", dryRun: true,
        });
        const after = ec.entity.find("moqui.math.Parameter").condition("parameterId", "TestPlcReferenceParam").one().numericValue;
        return { before, after, output };
    },
    then(out) {
        out.after == out.before;
        out.output.sourceParameterCount == 2;
    },
});

feature("HTTP wrapper preserves JSON data and uses an API header", {
    ignore: !System.getProperty("gateway_test_url"),
    when() {
        return call("moqui.device.DeviceGatewayServices.call#GatewayEndpoint", {
            url: System.getProperty("gateway_test_url") + "/echo", apiKey: "test-only-token",
            payload: { filename: "binary.bin", contentBase64: "AP8Q", axes: { X: [1, 2] } },
        });
    },
    then(out) {
        out.response.apiKey == "test-only-token";
        out.response.query == "";
        out.response.body.contentBase64 == "AP8Q";
        out.response.body.axes.X[1] == 2;
        out.response.body.url == null;
    },
});

feature("HTTP errors do not produce a success response", {
    ignore: !System.getProperty("gateway_test_url"),
    allowMessageErrors: true,
    when() {
        let failed = false;
        try {
            call("moqui.device.DeviceGatewayServices.call#GatewayEndpoint", { url: System.getProperty("gateway_test_url") + "/fail" });
            failed = ec.message.hasError();
        } catch (err) { failed = true; }
        return { failed };
    },
    then(out) { out.failed == true; },
});

feature("OpenVLA sends the exact binary image through the MR resource stream", {
    ignore: !System.getProperty("gateway_test_url"),
    when() {
        const location = "/tmp/moqui-openvla-contract.bin";
        ec.resource.getLocationReference(location).putBytes(new Uint8Array([0, 255, 16]));
        call("store#moqui.device.DeviceContent", {deviceContentId:"OpenVlaContractImage", deviceId:"VIRTUAL_PLC_01", contentTypeEnumId:"DCntImage", contentLocation:location});
        return call("moqui.device.TrajectoryPlannerServices.run#OpenVla", {
            deviceId:"VIRTUAL_PLC_01", deviceContentId:"OpenVlaContractImage", prompt:"test", openVlaBaseUrl:System.getProperty("gateway_test_url"),
        });
    },
    then(out) {
        out.modelId == "bytes:AP8Q";
        out.action[2] == 3;
    },
    cleanup() {
        call("delete#moqui.device.DeviceContent", {deviceContentId:"OpenVlaContractImage"});
        ec.resource.getLocationReference("/tmp/moqui-openvla-contract.bin").delete();
    },
});

feature("the demo planner explicitly labels interpolation and persists waypoints", {
    when() {
        const result = call("moqui.device.TrajectoryPlannerServices.run#RobotArmTrajectoryPlanner", {
            mathModelId:"TrjPlannerMlp6DofV1", plannerMode:"linear-demo",
            startPose:[0,0,0,0,0,0], goalPose:[9,18,27,0,0,0],
        });
        return {
            result,
            approximation: ec.entity.find("moqui.math.ApproximatedFunction").condition("approximatedFunctionId",result.approximatedFunctionId).one(),
            samples: ec.entity.find("moqui.math.ApproximatedFunctionSample").condition("approximatedFunctionId",result.approximatedFunctionId).count(),
        };
    },
    then(out) {
        out.result.mathModelRunId != null;
        out.approximation.interpolationEnumId == "AfiLinearPath";
        out.samples == 10;
    },
});

feature("grounding persists vector data through the MR entity API", {
    ignore: !System.getProperty("gateway_test_url"),
    when() {
        ec.resource.getLocationReference("/tmp/moqui-grounding-contract.bin").putBytes(new Uint8Array([0,255,16]));
        call("store#moqui.device.DeviceContent", {deviceContentId:"GroundingContractImage", deviceId:"VIRTUAL_PLC_01", contentTypeEnumId:"DCntImage", contentLocation:"/tmp/moqui-grounding-contract.bin"});
        return call("moqui.device.TrajectoryPlannerServices.run#OpenVlaGrounding", {
            deviceId:"VIRTUAL_PLC_01", deviceContentId:"GroundingContractImage", prompt:"test", openVlaBaseUrl:System.getProperty("gateway_test_url"), saveResult:true, returnTargetPose:true,
        });
    },
    then(out) {
        out.centerVectorId != null;
        out.targetPoseVectorId != null;
        out.boundingBox[3] == 4;
    },
    cleanup() {
        call("delete#moqui.device.DeviceContent", {deviceContentId:"GroundingContractImage"});
        ec.resource.getLocationReference("/tmp/moqui-grounding-contract.bin").delete();
    },
});

feature("remote trajectory planning persists provider waypoints", {
    ignore: !System.getProperty("gateway_test_url"),
    when() {
        const output = call("moqui.device.TrajectoryPlannerServices.run#RobotArmTrajectoryPlanner", {
            plannerMode:"remote", mathModelId:"TrjPlannerMlp6DofV1", inferenceUrl:System.getProperty("gateway_test_url") + "/plan",
            startPose:[0,0,0,0,0,0], goalPose:[1,2,3,0,0,0],
        });
        return { output, samples:ec.entity.find("moqui.math.ApproximatedFunctionSample").condition("approximatedFunctionId",output.approximatedFunctionId).count() };
    },
    then(out) {
        out.output.mathModelRunId != null;
        out.samples == 2;
    },
});

feature("the demo planner rejects obstacles before creating a trajectory", {
    allowMessageErrors: true,
    when() {
        let failed = false;
        try {
            call("moqui.device.TrajectoryPlannerServices.run#RobotArmTrajectoryPlanner", {
                mathModelId:"TrjPlannerMlp6DofV1", plannerMode:"linear-demo",
                startPose:[0,0,0,0,0,0], goalPose:[1,0,0,0,0,0],
                obstacle:{center:[0.5,0,0], radius:0.12},
            });
            failed = ec.message.hasError();
        } catch (error) { failed = true; }
        return {failed};
    },
    then(out) { out.failed == true; },
});

feature("actual Rust ONNX obstacle replanning persists the changed trajectory", {
    ignore: !System.getProperty("trajectory_onnx_test_url"),
    when() {
        const parameters = {
            plannerMode:"remote", mathModelId:"DemoObstacleCorridorV1", inferenceUrl:System.getProperty("trajectory_onnx_test_url") + "/plan",
            startPose:[0,0,0,0,0,0], goalPose:[1,0,0,0,0,0],
        };
        const before = call("moqui.device.TrajectoryPlannerServices.run#RobotArmTrajectoryPlanner", parameters);
        parameters.obstacle = {center:[0.5,0,0], radius:0.12, margin:0.08, coordinateFrame:"demo-tcp-metres"};
        const after = call("moqui.device.TrajectoryPlannerServices.run#RobotArmTrajectoryPlanner", parameters);
        const run = ec.entity.find("moqui.math.MathModelRun").condition("mathModelRunId",after.mathModelRunId).one();
        const middleY = (id) => {
            const sample = ec.entity.find("moqui.math.ApproximatedFunctionSample")
                .condition("approximatedFunctionId",id).condition("sampleCode","WP0005").one();
            return ec.entity.find("moqui.math.VectorComponent").condition("vectorId",sample.sampleVectorId)
                .condition("dimensionIndex",1).one().realValue.toNumber();
        };
        return {
            before, after, run, beforeY:middleY(before.approximatedFunctionId), afterY:middleY(after.approximatedFunctionId),
            samples:ec.entity.find("moqui.math.ApproximatedFunctionSample").condition("approximatedFunctionId",after.approximatedFunctionId).count(),
            approximation:ec.entity.find("moqui.math.ApproximatedFunction").condition("approximatedFunctionId",after.approximatedFunctionId).one(),
        };
    },
    then(out) {
        out.before.approximatedFunctionId != out.after.approximatedFunctionId;
        out.run.hasError == "N";
        JSON.parse(out.run.parameters).obstacle.radius == 0.12;
        out.samples == 11;
        out.approximation.interpolationEnumId == "AfiAIPath";
        Math.abs(Number(out.beforeY)) < 0.00001;
        Math.abs(Number(out.afterY) - 0.20) < 0.00001;
    },
});
