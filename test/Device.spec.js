// MR-Moqui component regression tests. The OpenVLA contract checks use inference_test_url pointing at a local fixture
// server, and the ONNX planner checks need trajectory_native_test with a binary built with the onnx feature and
// ORT_DYLIB_PATH set (see test/README.md).
spec({
    setup() {
        ec.artifactExecution.disableAuthz()
    },
    cleanup() {
        ec.artifactExecution.enableAuthz()
    }
})

const failure = run => {
    try {
        run()
        return ec.message.hasError() ? String(ec.message.getErrorsString()) : null
    } catch (error) {
        return String(error && error.message ? error.message : error)
    }
}

feature("the canonical gateway scenario and HVAC whitelist load", {
    when() {
        return {
            gateway: ec.entity.find("moqui.device.PhysicalDevice").condition("deviceId", "GW_EDGE_01").one(),
            items: ec.entity
                .find("moqui.device.DeviceRequestItem")
                .condition("requestName", "HVAC_DEMO_LiveParametersWrite")
                .count(),
            parameter: ec.entity.find("moqui.math.Parameter").condition("parameterId", "TestPlcReferenceParam").one()
        }
    },
    then(out) {
        out.gateway != null
        out.items == 20
        out.parameter.numericValue == 300
    }
})

feature("configuration dry run preserves device values", {
    when() {
        const before = ec.entity.find("moqui.math.Parameter").condition("parameterId", "TestPlcReferenceParam").one().numericValue
        const output = call("moqui.device.DeviceServices.apply#DeviceConfig", {
            deviceId: "VIRTUAL_PLC_01",
            deviceConfigId: "TestPlcGatewayConfig1",
            dryRun: true
        })
        const after = ec.entity.find("moqui.math.Parameter").condition("parameterId", "TestPlcReferenceParam").one().numericValue
        return {before, after, output}
    },
    then(out) {
        out.after == out.before
        out.output.sourceParameterCount == 2
    }
})

feature("a configuration refuses a device of another type", {
    allowMessageErrors: true,
    when() {
        return {
            message: failure(() =>
                call("moqui.device.DeviceServices.apply#DeviceConfig", {
                    deviceId: "GW_EDGE_01",
                    deviceConfigId: "TestPlcGatewayConfig1"
                })
            )
        }
    },
    then(out) {
        out.message.includes("is not compatible with DeviceConfig [TestPlcGatewayConfig1]")
    }
})

feature("a rule set renders as one recipe file per priority", {
    when() {
        return call("moqui.device.DeviceServices.get#DeviceConfigExportFiles", {deviceRuleSetId: "TestPlcGatewayRuleSet1"})
    },
    then(out) {
        out.files.length == 1
        out.files[0].name == "Test PLC Gateway Rule Set_p10.txt"
        out.files[0].rowCount == 2
        out.files[0].content.split("\n")[0].startsWith("dev.PLC_RECIPE_REFERENCE:=250")
        out.files[0].content.split("\n")[1] == "dev.PLC_RECIPE_STATE:=AUTO"
    }
})

feature("a rule set with a trajectory renders the trajectory points of the former gateway export", {
    when() {
        return call("moqui.device.DeviceServices.get#DeviceConfigExportFiles", {deviceRuleSetId: "TestPlcTrajectoryRuleSet1"})
    },
    then(out) {
        out.files.length == 1
        out.files[0].name == "TestPlcTrajectoryRuleSet_p01.txt"
        out.files[0].content.includes("Trajectory.trajectoryId:=TestPlcTrajectory01")
        out.files[0].content.includes("Trajectory.pointCount:=2")
        out.files[0].content.includes("Trajectory.points[0].isBreakPoint:=FALSE")
        out.files[0].content.includes("Trajectory.points[1].isBreakPoint:=TRUE")
        out.files[0].content.includes("Trajectory.points[0].sequenceNum:=1")
        out.files[0].content.includes("Trajectory.points[0].pos.v[0]:=100")
        out.files[0].content.includes("Trajectory.points[1].pos.v[2]:=350")
        out.files[0].content.includes("Trajectory.points[0].timeOffsetMs:=500")
        out.files[0].content.includes("Trajectory.points[0].bufferMode:=3")
        out.files[0].content.includes("Trajectory.points[0].transitionMode:=0")
        out.files[0].content.includes("Trajectory.points[0].blendingMode:=10")
        out.files[0].content.includes("Trajectory.points[1].blendingMode:=0")
    }
})

feature("the trajectory generator checks a pose as the Groovy class did", {
    when() {
        const generator = ec.getTool("TrajectoryGenerator")
        return {
            pose: generator.normalizePoseVector([1, "2.5", 3, 4, 5, 6], "startPose"),
            short: failure(() => generator.normalizePoseVector([1, 2, 3, 4, 5], "goalPose")),
            text: failure(() => generator.normalizePoseVector([1, 2, 3, 4, 5, "x"], "goalPose")),
            numbers: generator.normalizeNumberList(["1", 2], "center", 2),
            none: generator.normalizeNumberList(null, "center", 2),
            image: (() => {
                const location = "/tmp/moqui-trajectory-image.bin"
                ec.resource.getLocationReference(location).putBytes(new Uint8Array([0, 255, 16]))
                try {
                    return generator.imageBase64(location)
                } finally {
                    ec.resource.getLocationReference(location).delete()
                }
            })()
        }
    },
    then(out) {
        out.pose.length == 6
        out.pose[1] == 2.5
        out.short.includes("goalPose must contain exactly 6 numeric values, found 5.")
        out.text.includes("goalPose[5] must be numeric, found value 'x'.")
        out.numbers.length == 2
        String(out.numbers[0]) == "1"
        out.none == null
        out.image == "AP8Q"
    }
})

feature("the planner refuses a pose that is not six numbers before it runs the model", {
    allowMessageErrors: true,
    when() {
        const runsBefore = ec.entity.find("moqui.math.MathModelRun").condition("mathModelId", "TrjPlannerMlp6DofV1").count()
        const message = failure(() =>
            call("moqui.device.TrajectoryPlannerServices.run#RobotArmTrajectoryPlanner", {
                mathModelId: "TrjPlannerMlp6DofV1",
                startPose: [0, 0, 0, 0, 0],
                goalPose: [1, 0, 0, 0, 0, 0]
            })
        )
        const runsAfter = ec.entity.find("moqui.math.MathModelRun").condition("mathModelId", "TrjPlannerMlp6DofV1").count()
        return {message, runsBefore, runsAfter}
    },
    then(out) {
        out.message.includes("startPose must contain exactly 6 numeric values, found 5.")
        out.runsAfter == out.runsBefore
    }
})

feature("the ONNX planner persists the waypoints of the bundled model", {
    ignore: !System.getProperty("trajectory_native_test"),
    when() {
        const generator = ec.getTool("TrajectoryGenerator")
        generator.clear()
        const loadsBefore = generator.loadCount()
        const parameters = {mathModelId: "TrjPlannerMlp6DofV1", startPose: [0, 0, 0, 0, 0, 0], goalPose: [1, 2, 3, 0, 0, 0]}
        const result = call("moqui.device.TrajectoryPlannerServices.run#RobotArmTrajectoryPlanner", parameters)
        call("moqui.device.TrajectoryPlannerServices.run#RobotArmTrajectoryPlanner", parameters)
        const find = entityName => ec.entity.find(entityName).condition("approximatedFunctionId", result.approximatedFunctionId)
        return {
            result,
            loads: generator.loadCount() - loadsBefore,
            sessions: generator.sessionCount(),
            approximation: find("moqui.math.ApproximatedFunction").one(),
            samples: find("moqui.math.ApproximatedFunctionSample").count(),
            points: find("moqui.math.TrajectoryPoint").count(),
            run: ec.entity.find("moqui.math.MathModelRun").condition("mathModelRunId", result.mathModelRunId).one(),
            perf: ec.entity.find("moqui.math.MathModelPerf").condition("mathModelPerfId", result.mathModelPerfId).one(),
            data: ec.entity.find("moqui.math.MathModelData").condition("generatedByRunId", result.mathModelRunId).count()
        }
    },
    then(out) {
        out.approximation.interpolationEnumId == "AfiAIPath"
        out.samples > 1
        out.points == out.samples
        out.run.hasError == "N"
        JSON.parse(out.run.results).waypointCount == out.samples
        out.perf != null
        out.data == 3
        out.loads == 1
        out.sessions == 1
    }
})

feature("OpenVLA sends the exact binary image and the key of the provider", {
    ignore: !System.getProperty("inference_test_url"),
    when() {
        const location = "/tmp/moqui-openvla-contract.bin"
        ec.resource.getLocationReference(location).putBytes(new Uint8Array([0, 255, 16]))
        call("store#moqui.device.DeviceContent", {
            deviceContentId: "OpenVlaContractImage",
            deviceId: "VIRTUAL_PLC_01",
            contentTypeEnumId: "DCntImage",
            contentLocation: location
        })
        return call("moqui.device.TrajectoryPlannerServices.run#OpenVla", {
            deviceId: "VIRTUAL_PLC_01",
            deviceContentId: "OpenVlaContractImage",
            prompt: "test",
            apiKey: "test key",
            openVlaBaseUrl: System.getProperty("inference_test_url") + "/"
        })
    },
    then(out) {
        out.modelId == "bytes:AP8Q"
        out.action[2] == 3
        out.unnormKey == "apiKey=test%20key"
    },
    cleanup() {
        call("delete#moqui.device.DeviceContent", {deviceContentId: "OpenVlaContractImage"})
        ec.resource.getLocationReference("/tmp/moqui-openvla-contract.bin").delete()
    }
})

feature("grounding persists vector data through the MR entity API", {
    ignore: !System.getProperty("inference_test_url"),
    when() {
        ec.resource.getLocationReference("/tmp/moqui-grounding-contract.bin").putBytes(new Uint8Array([0, 255, 16]))
        call("store#moqui.device.DeviceContent", {
            deviceContentId: "GroundingContractImage",
            deviceId: "VIRTUAL_PLC_01",
            contentTypeEnumId: "DCntImage",
            contentLocation: "/tmp/moqui-grounding-contract.bin"
        })
        const out = call("moqui.device.TrajectoryPlannerServices.run#OpenVlaGrounding", {
            deviceId: "VIRTUAL_PLC_01",
            deviceContentId: "GroundingContractImage",
            prompt: "test",
            openVlaBaseUrl: System.getProperty("inference_test_url"),
            saveResult: true,
            returnTargetPose: true
        })
        out.centerComponents = ec.entity.find("moqui.math.VectorComponent").condition("vectorId", out.centerVectorId).count()
        out.maxVector = ec.entity.find("moqui.math.Vector").condition("vectorId", out.boundingBoxMaxVectorId).one()
        return out
    },
    then(out) {
        out.centerVectorId != null
        out.targetPoseVectorId != null
        String(out.boundingBox[3]) == "4"
        out.goalPose.length == 6
        out.objectLabel == "fixture"
        out.coordinateSystem == "image-pixel"
        out.centerComponents == 2
        out.maxVector.name == "bbox_max_VIRTUAL_PLC_01"
        out.maxVector.vectorSpaceEnumId == "EuclideanSpace2D"
    },
    cleanup() {
        call("delete#moqui.device.DeviceContent", {deviceContentId: "GroundingContractImage"})
        ec.resource.getLocationReference("/tmp/moqui-grounding-contract.bin").delete()
    }
})

feature("OpenVLA errors do not produce a success response", {
    ignore: !System.getProperty("inference_test_url"),
    allowMessageErrors: true,
    when() {
        return {
            message: failure(() =>
                call("moqui.device.TrajectoryPlannerServices.call#OpenVla", {
                    openVlaLocation: System.getProperty("inference_test_url") + "/fail",
                    instruction: "test",
                    image_base64: "AP8Q"
                })
            )
        }
    },
    then(out) {
        out.message != null
    }
})
