// MR-Moqui component regression tests. Optional HTTP contract checks use
// gateway_test_url pointing at a local fixture server (see test/README.md).
spec({
    setup() { ec.artifactExecution.disableAuthz(); },
    cleanup() { ec.artifactExecution.enableAuthz(); },
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
            mathModelId:"TrjPlannerMlp6DofV1", inferenceUrl:System.getProperty("gateway_test_url") + "/plan",
            startPose:[0,0,0,0,0,0], goalPose:[1,2,3,0,0,0],
        });
        return { output, samples:ec.entity.find("moqui.math.ApproximatedFunctionSample").condition("approximatedFunctionId",output.approximatedFunctionId).count() };
    },
    then(out) {
        out.output.mathModelRunId != null;
        out.samples == 2;
    },
});
