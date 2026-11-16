// The recipe export, the file transfer, the sample store and the gateway scope of moqui-device, with no driver
// installed. From the framework root: ./moq test --debug moqui-device. The requests are those of DeviceTestData.xml.
// Optional feature:
//   gateway_sftp_test=1: an SFTP server on 127.0.0.1:2223, user foo/pass, directory /upload, whose host key
//     fingerprint (SHA256:...) is in gateway_sftp_fingerprint.
// Files go to /tmp/moqui-gateway-spec.
spec({
    setup() {
        ec.artifactExecution.disableAuthz()
        const broker = System.getProperty("gateway_mqtt_test_broker")
        if (broker)
            for (const row of ec.entity.find("moqui.device.DeviceRequest").list()) {
                if (row.brokerUri?.includes("tcp://localhost:1883")) {
                    row.brokerUri = row.brokerUri.replace("tcp://localhost:1883", broker)
                    row.update()
                }
            }
    },
    cleanup() {
        ec.artifactExecution.enableAuthz()
    }
})

const specDir = "/tmp/moqui-gateway-spec"
const readText = path => ec.resource.getLocationReference(path).getText()
const removeFile = path => {
    try {
        ec.resource.getLocationReference(path).delete()
    } catch (e) {
        /* not there */
    }
}
const mqttBroker = System.getProperty("gateway_mqtt_test_broker") || "tcp://localhost:1883"
const mqttUri = "paho-mqtt5:?brokerUrl=" + mqttBroker + "&userName=artemis&password=artemis"
const storeRequest = fields => call("store#moqui.device.DeviceRequest", Object.assign({timeout: 5000}, fields))
const deleteRequests = (...names) =>
    names.forEach(requestName => {
        ec.entity.find("moqui.device.DeviceRequestItem").condition("requestName", requestName).deleteAll()
        ec.entity.find("moqui.device.DeviceRequest").condition("requestName", requestName).deleteAll()
    })
// publish one JSON message on a topic, through an MQTT write request without items
const publish = (topic, payload) => {
    storeRequest({
        requestName: "GatewayTestPublish",
        deviceId: "VIRTUAL_PLC_01",
        requestTypeEnumId: "DrtWrite",
        routerEnumId: "DrrMQTTBroker",
        brokerUri: mqttUri,
        query: topic
    })
    return call("moqui.device.DeviceServices.run#DeviceRequest", {requestName: "GatewayTestPublish", payload})
}
// wait for a condition the persistence worker makes true, at most a few seconds
const waitFor = (condition, millis = 8000) => {
    const started = Date.now()
    let value = condition()
    while (!value && Date.now() - started < millis) value = condition()
    return value
}
// a group membership status, set directly: the status flow of DeviceGroupMember does not go back from Down to Alive
const setMemberStatus = (deviceId, memberDeviceId, statusId) => {
    const member = ec.entity
        .find("moqui.device.DeviceGroupMember")
        .condition("deviceId", deviceId)
        .condition("memberDeviceId", memberDeviceId)
        .useCache(false)
        .one()
    member.statusId = statusId
    member.update()
}
const failureOf = action => {
    try {
        action()
        return ec.message.hasError() ? ec.message.getErrorsString() : null
    } catch (e) {
        return String(e.message || e)
    }
}

const exportTo = (requestName, connectionName, transportConfig, options) => {
    call("store#moqui.device.DeviceConnection", {
        connectionName,
        deviceId: "VIRTUAL_PLC_01",
        connectionTypeEnumId: "DctDirectConnection",
        purposeEnumId: "DcpMaintenance",
        transportConfig,
        options,
        driverEnumId: transportConfig.startsWith("sftp:") ? "DcdSftp" : "DcdFile"
    })
    call("update#moqui.device.DeviceRequest", {requestName, connectionName})
}
const unexport = (requestName, connectionName) => {
    call("update#moqui.device.DeviceRequest", {requestName, connectionName: null})
    call("delete#moqui.device.DeviceConnection", {connectionName})
}

feature("a recipe export writes one file per rule priority to the connection of its request", {
    when() {
        exportTo("VIRTUAL_PLC_01_ExportProcess", "GatewayTestExportFiles", `file:${specDir}/plc1`)
        const out = call("moqui.device.DeviceServices.export#DeviceConfig", {
            deviceRuleSetId: "TestPlcGatewayRuleSet1",
            requestName: "VIRTUAL_PLC_01_ExportProcess"
        })
        return {out, recipe: readText(`${specDir}/plc1/Test PLC Gateway Rule Set_p10.txt`)}
    },
    then(r) {
        r.out.status == "completed"
        r.out.files.length == 1
        r.out.files[0].rowCount == 2
        r.out.transferredFiles[0].endsWith("/plc1/Test PLC Gateway Rule Set_p10.txt")
        r.recipe.includes("dev.PLC_RECIPE_REFERENCE:=250")
        r.recipe.includes("dev.PLC_RECIPE_STATE:=AUTO")
    },
    cleanup() {
        unexport("VIRTUAL_PLC_01_ExportProcess", "GatewayTestExportFiles")
        removeFile(`${specDir}/plc1/Test PLC Gateway Rule Set_p10.txt`)
    }
})

feature("a transfer that fails at one destination deletes what it wrote at every destination", {
    allowMessageErrors: true,
    when() {
        const devices = ec.resource.script("component://moqui-device/service/moqui/device/Devices.js")
        const failure = failureOf(() =>
            devices.execute("transferFiles", {
                // /proc takes no new file: the second destination fails after the first got both files
                destinations: [{endpoint: `file:${specDir}/rollback`}, {endpoint: "file:/proc/moqui-device-spec"}],
                files: [
                    {name: "recipe_p10.txt", content: "a:=1"},
                    {name: "recipe_p20.txt", content: "b:=2"}
                ]
            })
        )
        ec.message.clearErrors()
        return {
            failure,
            first: ec.resource.getLocationReference(`${specDir}/rollback/recipe_p10.txt`).getExists(),
            second: ec.resource.getLocationReference(`${specDir}/rollback/recipe_p20.txt`).getExists()
        }
    },
    then(r) {
        r.failure.includes("files it had written were deleted")
        r.first == false
        r.second == false
    }
})

feature("a trajectory recipe is written as the Camel gateway wrote it", {
    when() {
        exportTo("VIRTUAL_PLC_01_ExportProcess", "GatewayTestExportTrajectory", `file:${specDir}/trajectory`)
        const out = call("moqui.device.DeviceServices.export#DeviceConfig", {
            deviceRuleSetId: "TestPlcTrajectoryRuleSet1",
            requestName: "VIRTUAL_PLC_01_ExportProcess"
        })
        return {out, recipe: readText(`${specDir}/trajectory/TestPlcTrajectoryRuleSet_p01.txt`)}
    },
    then(out) {
        out.out.status == "completed"
        out.out.files[0].name == "TestPlcTrajectoryRuleSet_p01.txt"
        out.recipe.includes("Trajectory.trajectoryId:=TestPlcTrajectory01")
        out.recipe.includes("Trajectory.pointCount:=2")
        out.recipe.includes("Trajectory.points[0].isBreakPoint:=FALSE")
        out.recipe.includes("Trajectory.points[1].isBreakPoint:=TRUE")
        out.recipe.includes("Trajectory.points[0].pos.v[0]:=")
        out.recipe.includes("Trajectory.points[0].blendingMode:=10")
    },
    cleanup() {
        unexport("VIRTUAL_PLC_01_ExportProcess", "GatewayTestExportTrajectory")
        removeFile(`${specDir}/trajectory/TestPlcTrajectoryRuleSet_p01.txt`)
    }
})

feature("a recipe export without a destination is refused", {
    allowMessageErrors: true,
    when() {
        const failure = failureOf(() =>
            call("moqui.device.DeviceServices.export#DeviceConfig", {
                deviceRuleSetId: "TestPlcGatewayRuleSet1",
                requestName: "VIRTUAL_PLC_01_ExportProcess"
            })
        )
        ec.message.clearErrors()
        return {failure}
    },
    then(out) {
        out.failure.includes("has no destination")
    }
})

feature("a content transfer writes the DeviceContent to the destination of its request", {
    when() {
        const location = "/tmp/moqui-gateway-transfer.bin"
        ec.resource.getLocationReference(location).putBytes(new Uint8Array([0, 255, 16]))
        call("store#moqui.device.DeviceContent", {
            deviceContentId: "GatewayTransferContent",
            deviceId: "VIRTUAL_PLC_01",
            contentTypeEnumId: "DCntImage",
            contentLocation: location
        })
        call("update#moqui.device.DeviceRequest", {
            requestName: "VIRTUAL_PLC_01_TransferContent",
            brokerUri: `file:${specDir}/content`
        })
        const out = call("moqui.device.DeviceServices.transfer#DeviceContent", {
            requestName: "VIRTUAL_PLC_01_TransferContent",
            deviceContentId: "GatewayTransferContent"
        })
        const stream = ec.resource.getLocationReference(`${specDir}/content/moqui-gateway-transfer.bin`).openStream()
        try {
            out.bytes = Array.from(stream.readAllBytes())
        } finally {
            stream.close()
        }
        return out
    },
    then(out) {
        out.status == "completed"
        out.transferredFiles[0].endsWith("/content/moqui-gateway-transfer.bin")
        out.bytes.join(",") == "0,255,16"
    },
    cleanup() {
        call("update#moqui.device.DeviceRequest", {
            requestName: "VIRTUAL_PLC_01_TransferContent",
            brokerUri: "file:target/transferred-content/plc"
        })
        call("delete#moqui.device.DeviceContent", {deviceContentId: "GatewayTransferContent"})
        removeFile("/tmp/moqui-gateway-transfer.bin")
        removeFile(`${specDir}/content/moqui-gateway-transfer.bin`)
    }
})

feature("a content transfer refuses the content of another device", {
    allowMessageErrors: true,
    when() {
        call("store#moqui.device.DeviceContent", {
            deviceContentId: "GatewayForeignContent",
            deviceId: "DRV_EDGE_01",
            contentTypeEnumId: "DCntImage",
            contentLocation: "/tmp/moqui-gateway-foreign.bin"
        })
        const failure = failureOf(() =>
            call("moqui.device.DeviceServices.transfer#DeviceContent", {
                requestName: "VIRTUAL_PLC_01_TransferContent",
                deviceContentId: "GatewayForeignContent"
            })
        )
        ec.message.clearErrors()
        return {failure}
    },
    then(out) {
        out.failure.includes("different device")
    },
    cleanup() {
        call("delete#moqui.device.DeviceContent", {deviceContentId: "GatewayForeignContent"})
    }
})

feature("stored samples update the parameter once and skip an equal value", {
    when() {
        const samples = [{deviceId: "VIRTUAL_PLC_01", parameterId: "TestPlcFeedbackParam", value: 42.5}]
        const first = call("moqui.device.DeviceAcquisitionServices.store#Samples", {
            requestName: "TestPlcOpcUaReadReq01",
            samples
        })
        const second = call("moqui.device.DeviceAcquisitionServices.store#Samples", {
            requestName: "TestPlcOpcUaReadReq01",
            samples
        })
        const parameter = ec.entity.find("moqui.math.Parameter").condition("parameterId", "TestPlcFeedbackParam").one()
        return {first, second, value: parameter.numericValue.toNumber()}
    },
    then(out) {
        out.first.results[0].status == "stored"
        out.second.results[0].status == "unchanged"
        out.value == 42.5
    }
})

feature("a sample of another device is not stored", {
    when() {
        return call("moqui.device.DeviceAcquisitionServices.store#Samples", {
            requestName: "TestPlcOpcUaReadReq01",
            samples: [{deviceId: "DRV_EDGE_01", parameterId: "TestPlcFeedbackParam", value: 1}]
        })
    },
    then(out) {
        out.failedCount == 1
        out.results[0].status == "failed"
    }
})

feature("an existing parameter outside the request items is refused", {
    when() {
        return call("moqui.device.DeviceAcquisitionServices.store#Samples", {
            requestName: "TestPlcOpcUaReadReq01",
            samples: [{deviceId: "VIRTUAL_PLC_01", parameterId: "TestPlcReferenceParam", value: 123}]
        })
    },
    then(out) {
        out.failedCount == 1
        out.results[0].error.includes("not declared")
    }
})

feature("PLC logs cannot impersonate a device outside the owner's hierarchy", {
    when() {
        return call("moqui.device.DeviceAcquisitionServices.store#LogSamples", {
            requestName: "TestPlcOpcUaReadReq01",
            samples: [{deviceId: "DRV_EDGE_01", value: {message: "outside hierarchy"}}]
        })
    },
    then(out) {
        out.failedCount == 1
        out.results[0].error.includes("hierarchy")
    }
})

feature("the gateway scope is its groups and their alive members", {
    when() {
        return {
            scope: call("moqui.device.DeviceAcquisitionServices.get#GatewayScope", {gatewayDeviceId: "GW_EDGE_01"}),
            notGateway: call("moqui.device.DeviceAcquisitionServices.get#GatewayScope", {gatewayDeviceId: "DRV_EDGE_01"}),
            missing: call("moqui.device.DeviceAcquisitionServices.get#GatewayScope", {gatewayDeviceId: "NO_SUCH_GATEWAY"})
        }
    },
    then(out) {
        out.scope.ready == true
        out.scope.scopedDeviceIds.includes("VIRTUAL_PLC_01")
        out.scope.scopedDeviceIds.includes("DRV_EDGE_01")
        !out.scope.scopedDeviceIds.includes("HVAC_DEMO_PLC")
        out.scope.controllerDeviceIds.includes("VIRTUAL_PLC_01")
        !out.scope.controllerDeviceIds.includes("DRV_EDGE_01")
        out.notGateway.ready == false
        out.notGateway.message.includes("DgmpEdgeGateway")
        out.missing.ready == false
        out.missing.message.includes("PhysicalDevice")
    }
})

feature("the startup subscriptions are those of the controllers in the gateway scope, in order", {
    when() {
        return call("moqui.device.DeviceAcquisitionServices.get#StartupSubscriptions", {gatewayDeviceId: "GW_EDGE_01"})
    },
    then(out) {
        out.ready == true
        // every subscription of the controllers, with or without runServiceName: without one it runs on its driver
        out.requestNames.length == 4
        out.requestNames[0] == "TestPlcMqttSubscribeReq01"
        out.requestNames[1] == "TestPlcOpcUaReadReq01"
        out.requestNames.includes("VIRTUAL_PLC_01_LiveParametersMqttSub")
        out.requestNames.includes("VIRTUAL_PLC_01_FrameworkStatusRead")
    }
})

feature("an inactive gateway membership leaves the gateway without a scope", {
    when() {
        setMemberStatus("DG_EDGE_01", "GW_EDGE_01", "DgmsDown")
        return call("moqui.device.DeviceAcquisitionServices.get#StartupSubscriptions", {gatewayDeviceId: "GW_EDGE_01"})
    },
    then(out) {
        out.ready == false
        out.requestNames.length == 0
    },
    cleanup() {
        setMemberStatus("DG_EDGE_01", "GW_EDGE_01", "DgmsAlive")
    }
})

feature("an inactive controller membership excludes its subscriptions", {
    when() {
        setMemberStatus("DG_EDGE_01", "VIRTUAL_PLC_01", "DgmsDown")
        return call("moqui.device.DeviceAcquisitionServices.get#StartupSubscriptions", {gatewayDeviceId: "GW_EDGE_01"})
    },
    then(out) {
        out.ready == true
        out.requestNames.length == 0
    },
    cleanup() {
        setMemberStatus("DG_EDGE_01", "VIRTUAL_PLC_01", "DgmsAlive")
    }
})

feature("a recipe export reaches an SFTP server and can replace the same recipe", {
    // `moqui test` does not install the framework's SFTP client (moqui-host installs it when the server starts), so
    // this needs gateway_sftp_test and a test runner that does
    ignore: !System.getProperty("gateway_sftp_test") || !System.getProperty("gateway_sftp_client"),
    when() {
        // DeviceConnection.options holds 63 characters: the host key goes in the query of the destination
        exportTo(
            "VIRTUAL_PLC_01_ExportProcess",
            "GatewayTestSftp",
            `sftp://127.0.0.1:2223/upload?host-key-fingerprint=${encodeURIComponent(System.getProperty("gateway_sftp_fingerprint"))}`,
            "username=foo&password=pass"
        )
        const parameters = {deviceRuleSetId: "TestPlcGatewayRuleSet1", requestName: "VIRTUAL_PLC_01_ExportProcess"}
        call("moqui.device.DeviceServices.export#DeviceConfig", parameters)
        const out = call("moqui.device.DeviceServices.export#DeviceConfig", parameters)
        const root = System.getProperty("gateway_sftp_output_dir")
        if (root) {
            const expected = call("moqui.device.DeviceServices.get#DeviceConfigExportFiles", {
                deviceRuleSetId: "TestPlcGatewayRuleSet1"
            })
            out.actualContent = ec.resource.getLocationReference(root + "/" + expected.files[0].name).getText()
            out.expectedContent = expected.files[0].content
        }
        return out
    },
    then(out) {
        out.status == "completed"
        out.transferredFiles[0] == "sftp://127.0.0.1:2223/upload/Test PLC Gateway Rule Set_p10.txt"
        out.actualContent == out.expectedContent
    },
    cleanup() {
        unexport("VIRTUAL_PLC_01_ExportProcess", "GatewayTestSftp")
    }
})

feature("a group log request accepts its live members but not an inactive membership", {
    when() {
        // DeviceRequest belongs to a PhysicalDevice. That Device can also own an explicit group of child devices.
        call("create#moqui.device.DeviceGroup", {deviceId: "VIRTUAL_PLC_01", groupName: "Temporary PLC log ownership"})
        call("create#moqui.device.DeviceGroupMember", {
            deviceId: "VIRTUAL_PLC_01",
            memberDeviceId: "DRV_EDGE_01",
            statusId: "DgmsAlive",
            statusFlowId: "ClusterMembership"
        })
        storeRequest({
            requestName: "GatewayGroupLog",
            deviceId: "VIRTUAL_PLC_01",
            requestTypeEnumId: "DrtSubscribe",
            routerEnumId: "DrrMQTTBroker",
            brokerUri: mqttUri
        })
        const samples = [{deviceId: "DRV_EDGE_01", value: {message: "group log ownership test"}}]
        const accepted = call("moqui.device.DeviceAcquisitionServices.store#LogSamples", {
            requestName: "GatewayGroupLog",
            samples
        })
        setMemberStatus("VIRTUAL_PLC_01", "DRV_EDGE_01", "DgmsDown")
        try {
            const rejected = call("moqui.device.DeviceAcquisitionServices.store#LogSamples", {
                requestName: "GatewayGroupLog",
                samples
            })
            return {accepted, rejected}
        } finally {
            setMemberStatus("VIRTUAL_PLC_01", "DRV_EDGE_01", "DgmsAlive")
        }
    },
    then(out) {
        out.accepted.storedCount == 1
        out.rejected.failedCount == 1
    },
    cleanup() {
        deleteRequests("GatewayGroupLog")
        call("delete#moqui.device.DeviceGroupMember", {deviceId: "VIRTUAL_PLC_01", memberDeviceId: "DRV_EDGE_01"})
        call("delete#moqui.device.DeviceGroup", {deviceId: "VIRTUAL_PLC_01"})
    }
})
