// Devices screens (plan/design-devices.md §3): each screen rendered once (qvt, the shell's fragment with its lists' data; a tab
// on its own, as its panel loads it), with a
// text it shows whatever the data, and no render error; and a device that does not exist, "Not available". As the
// spec administrator (ADMIN).
// Run: ./moq test moqui-device --spec DevicesScreens
const lib = ec.resource.script("component://moqui-device/test/Devices/DevicesSpecLib.js")
const {users, ensureUsers, page} = lib

spec({
    setupSpec() {
        ensureUsers()
        ec.user.internalLoginUser(users.admin)
    },
    cleanupSpec() {
        ec.user.logoutLocal()
    }
})

feature("each screen renders with what it shows", {
    when() {
        const screens = [
            ["Home", {}, "Members out of service"],
            ["Devices/Find", {}, "Virtual PLC"],
            ["Devices/DeviceDetail/Overview", {deviceId: "VIRTUAL_PLC_01"}, "Apply task"],
            ["Devices/DeviceDetail/Parameters", {deviceId: "VIRTUAL_PLC_01", lastStandalone: "true"}, "TestPlcCycleTime"],
            ["Devices/DeviceDetail/Content", {deviceId: "VIRTUAL_PLC_01", lastStandalone: "true"}, "Add content"],
            ["Devices/DeviceDetail/Observability", {deviceId: "VIRTUAL_PLC_01", range: "all", lastStandalone: "true"}, "Device log"],
            ["Groups/Find", {}, "Device groups"],
            ["Groups/GroupDetail/Members", {deviceId: "DG_EDGE_01", lastStandalone: "true"}, "VIRTUAL_PLC_01"],
            ["Configs/Find", {}, "TestPlcFactoryConfig1"],
            ["Configs/ConfigDetail/Overview", {deviceConfigId: "TestPlcFactoryConfig1"}, "Edit"],
            ["Processes/Find", {}, "New process"],
            ["Processes/ProcessDetail/Tasks", {deviceRuleSetId: "TestPlcRunRuleSet1", lastStandalone: "true"}, "Apply PLC factory defaults"]
        ]
        const problems = []
        for (const [path, parameters, expected] of screens) {
            const rendered = page(path, parameters)
            if (rendered.status !== 200 || rendered.errors.length) problems.push(path + ": " + rendered.status + " " + rendered.errors.join(" | "))
            else if (!rendered.output.includes(expected)) problems.push(path + ": no " + expected)
        }
        // the record header's status chip has its own tui text
        const tui = page("Devices/DeviceDetail", {deviceId: "VIRTUAL_PLC_01"}, "tui")
        if (tui.status !== 200 || tui.errors.length || !tui.output.includes("Virtual PLC 01")) problems.push("DeviceDetail tui: " + tui.errors.join(" | "))
        const missing = page("Devices/DeviceDetail", {deviceId: "NO_SUCH_DEVICE"})
        return {problems: problems.join("\n"), missing: missing.output.includes("Not available") && missing.output.includes("All devices")}
    },
    then(out) {
        out.problems == ""
        out.missing == true
    }
})
