// Devices rules (plan/design-devices.md §4): the checks of a task's apply, a group's controller and its requests, the range of a
// parameter value, a task a device runs, a process that is its own parent, and every choice once with a selected value outside
// its page. As the spec administrator (ADMIN), with artifact authorization off.
// Run: ./moq test moqui-device --spec DevicesRules
const lib = ec.resource.script("component://moqui-device/test/Devices/DevicesSpecLib.js")
const {users, app, ensureUsers, refusal, invoke} = lib
const member = (deviceId, memberDeviceId) =>
    ec.entity.find("moqui.device.DeviceGroupMember").condition({deviceId, memberDeviceId}).useCache(false).one()
const setMemberStatus = (deviceId, memberDeviceId, statusId) => {
    const row = member(deviceId, memberDeviceId)
    row.statusId = statusId
    row.update()
}

spec({
    setupSpec() {
        ensureUsers()
        ec.user.internalLoginUser(users.admin)
    },
    cleanupSpec() {
        ec.user.logoutLocal()
    },
    setup() {
        ec.artifactExecution.disableAuthz()
    },
    cleanup() {
        ec.artifactExecution.enableAuthz()
    }
})

feature("a task applies only within its process and to the device it names", {
    when() {
        return {
            otherProcess: refusal(app + "apply#Task", {deviceId: "VIRTUAL_PLC_01", deviceRuleSetId: "TestCellFactoryRuleSet1",
                deviceRuleId: "TestPlcRunRule010"}),
            otherDevice: refusal(app + "apply#Task", {deviceId: "VIRTUAL_PLC_01", deviceRuleSetId: "TestCellFactoryRuleSet1",
                deviceRuleId: "TestCellFactoryRule010"})
        }
    },
    then(out) {
        /DEVICE_TASK_PROCESS/.test(out.otherProcess)
        /DEVICE_TASK_DEVICE/.test(out.otherDevice)
    }
})

feature("a group's controller is its first controller member in service, and its requests need one", {
    when() {
        const withController = invoke(app + "get#Device", {deviceId: "DG_EDGE_01"}).device
        setMemberStatus("DG_EDGE_01", "VIRTUAL_PLC_01", "DgmsDown")
        try {
            return {
                controller: withController.controllerDeviceId,
                isGroup: withController.isGroup,
                without: invoke(app + "get#Device", {deviceId: "DG_EDGE_01"}).device.controllerDeviceId,
                sync: refusal(app + "sync#Parameters", {deviceId: "DG_EDGE_01"})
            }
        } finally {
            setMemberStatus("DG_EDGE_01", "VIRTUAL_PLC_01", "DgmsAlive")
        }
    },
    then(out) {
        out.isGroup == true
        out.controller == "VIRTUAL_PLC_01"
        out.without == null
        /DEVICE_NO_CONTROLLER/.test(out.sync)
    }
})

feature("a device's requests are offered and run only when they exist", {
    when() {
        return {
            plc: invoke(app + "get#Device", {deviceId: "VIRTUAL_PLC_01"}).requests,
            drive: invoke(app + "get#Device", {deviceId: "DRV_EDGE_01"}).requests,
            driveSync: refusal(app + "sync#Parameters", {deviceId: "DRV_EDGE_01"})
        }
    },
    then(out) {
        out.plc.syncParameters == true
        out.plc.transferContent == true
        out.drive.syncParameters == false
        /DEVICE_NO_REQUEST/.test(out.driveSync)
    }
})

feature("a parameter value stays within its definition's range", {
    when() {
        return {
            above: refusal(app + "update#ParameterValue", {parameterId: "TestPlcCycleTimeParam", numericValue: "5000"}),
            below: refusal(app + "update#ParameterValue", {parameterId: "TestPlcCycleTimeParam", numericValue: "0"})
        }
    },
    then(out) {
        /DEVICE_VALUE_RANGE/.test(out.above)
        /DEVICE_VALUE_RANGE/.test(out.below)
    }
})

feature("a task a device runs is not deleted, and a process is not its own parent", {
    when() {
        const plc = ec.entity.find("moqui.device.Device").condition("deviceId", "VIRTUAL_PLC_01").useCache(false).one()
        const before = {deviceRuleSetId: plc.deviceRuleSetId, deviceRuleId: plc.deviceRuleId}
        invoke("update#moqui.device.Device", {deviceId: "VIRTUAL_PLC_01", deviceRuleSetId: "TestPlcRunRuleSet1", deviceRuleId: "TestPlcRunRule020"})
        try {
            return {
                inUse: refusal(app + "delete#Task", {deviceRuleId: "TestPlcRunRule020", deviceRuleSetId: "TestPlcRunRuleSet1"}),
                ownParent: refusal(app + "store#Process", {deviceRuleSetId: "TestPlcRunRuleSet1", parentRuleSetId: "TestPlcRunRuleSet1"})
            }
        } finally {
            invoke("update#moqui.device.Device", Object.assign({deviceId: "VIRTUAL_PLC_01"}, before))
        }
    },
    then(out) {
        /DEVICE_TASK_IN_USE/.test(out.inUse)
        /DEVICE_PROCESS_PARENT/.test(out.ownParent)
    }
})

feature("every choice offers its values and the selected one outside its page", {
    when() {
        const selected = {
            devices: "VIRTUAL_PLC_01",
            processes: "TestPlcRunRuleSet1",
            tasks: "TestPlcRunRule010",
            configs: "TestPlcFactoryConfig1",
            deviceTypes: "DtPhysicalDevice",
            devicePurposes: null,
            controlMethods: null,
            configTypes: null,
            processPurposes: null,
            taskTypes: null,
            contentTypes: null,
            trajectories: null
        }
        const problems = []
        for (const choice of Object.keys(selected)) {
            const parameters = {choice, deviceId: "VIRTUAL_PLC_01", deviceRuleSetId: "TestPlcRunRuleSet1"}
            const options = invoke(app + "get#Choices", parameters).options || []
            if (selected[choice]) {
                const outside = invoke(app + "get#Choices", Object.assign({term: "no such value zz", selected: selected[choice]}, parameters)).options
                if (!outside.length || outside[0].value !== selected[choice]) problems.push(choice + ": the selected value is not offered")
                if (!options.length) problems.push(choice + ": no options")
            }
        }
        return {problems: problems.join("; "), unknown: refusal(app + "get#Choices", {choice: "nothing"})}
    },
    then(out) {
        out.problems == ""
        /Unknown Devices choice/.test(out.unknown)
    }
})

feature("observability draws a logged parameter over time and lists the device log, a group's with its members'", {
    when() {
        const plc = invoke(app + "get#Observability", {deviceId: "VIRTUAL_PLC_01", parameterId: "TestPlcCycleTimeParam", range: "all"})
        const times = plc.frame.fields[0].values
        const group = invoke(app + "get#Observability", {deviceId: "DG_EDGE_01", range: "all"})
        return {
            parameterId: plc.parameterId,
            points: plc.pointCount,
            ascending: times.every((at, index) => index === 0 || times[index - 1] <= at),
            numeric: plc.frame.fields[1].type === "number" && plc.panel.visualization === "timeSeries",
            plcLogs: plc.deviceLogListCount,
            groupOptions: group.parameterOptions.map(option => option.value),
            groupLogs: group.deviceLogListCount,
            recent: invoke(app + "get#Observability", {deviceId: "VIRTUAL_PLC_01", parameterId: "TestPlcCycleTimeParam", range: "1h"}).pointCount
        }
    },
    then(out) {
        out.parameterId == "TestPlcCycleTimeParam"
        out.points == 4
        out.ascending == true
        out.numeric == true
        out.plcLogs > 0
        out.groupOptions.includes("TestPlcCycleTimeParam") && out.groupOptions.includes("TestDriveSpeedParam")
        out.groupLogs > out.plcLogs
        out.recent == 0
    }
})

feature("the HVAC demo series is written once, and a group shows the logs of the devices of its nested groups", {
    when() {
        const again = invoke("moqui.device.DeviceDemoServices.load#HvacDemoSeries")
        const plant = invoke(app + "get#Observability", {deviceId: "HVAC_DEMO", parameterId: "HvacTempFeedback", range: "7d", pageSize: 100})
        return {
            againLogs: again.parameterLogCount,
            againEvents: again.deviceLogCount,
            points: plant.pointCount,
            devices: Array.from(new Set(plant.deviceLogList.map(row => row.deviceName)))
        }
    },
    then(out) {
        out.againLogs == 0
        out.againEvents == 0
        out.points > 600
        out.devices.includes("HvacApplication") && out.devices.length > 2
    }
})
