// The Devices app's terminal sweep (plan/design-devices.md §6; AGENTS.md: one sweep per app per mode, in acceptance): every screen
// file under the Devices root, and the group routes that mount the device screens (Groups/Find, Groups/GroupDetail and its tabs) and
// ConfigDetail's Parameters, render in the tui render mode as a document of the TUI model (v 1) with no error node, on the test
// data's records, as the spec administrator (ADMIN) with artifact authorization on. Each screen's own checks are the regression
// specs DevicesScreens and DevicesRules.
// Run: ./moq accept moqui-device --spec DevicesTui
const root = "component://moqui-device/screen/Devices.xml"
const lib = ec.resource.script("component://moqui-device/test/Devices/DevicesSpecLib.js")
const mounts = ["Groups/Find", "Groups/GroupDetail", "Groups/GroupDetail/Overview", "Groups/GroupDetail/Members",
    "Groups/GroupDetail/Parameters", "Groups/GroupDetail/Content", "Groups/GroupDetail/Observability", "Configs/ConfigDetail/Parameters"]

function sweepScreens() {
    const files = []
    ec.resource.getLocationReference(root).walkChildTree(files, null)
    const own = files.filter(file => file.path !== "Devices" && file.location.endsWith(".xml")).map(file => file.path.substring("Devices/".length))
    return own.concat(mounts.filter(path => !own.includes(path)))
}
// the records a screen opens on
function parameters(path) {
    if (path.startsWith("Groups/GroupDetail")) return {deviceId: "DG_EDGE_01"}
    if (path.startsWith("Devices/DeviceDetail")) return {deviceId: "VIRTUAL_PLC_01"}
    if (path.startsWith("Configs/ConfigDetail")) return {deviceConfigId: "TestPlcFactoryConfig1"}
    if (path.startsWith("Processes/ProcessDetail")) return {deviceRuleSetId: "TestPlcRunRuleSet1"}
    return {}
}
function walk(nodes, errors) {
    for (const node of nodes || []) {
        if (!node || typeof node !== "object") continue
        if (node.t === "error") errors.push(node.text || node.message || JSON.stringify(node).substring(0, 200))
        if (node.t === "formList") for (const row of node.rows || []) for (const cell of row.cells || []) walk([].concat(cell), errors)
        walk(node.c, errors)
    }
}
function tui(path) {
    const rendered = ec.screen.makeTest().rootScreen(root).renderMode("tui").render(path, Object.assign({lastStandalone: "-2"}, parameters(path)), null)
    let doc = null
    try {
        doc = JSON.parse(rendered.output)
    } catch (error) {
        doc = null
    }
    const nodeErrors = []
    if (doc) walk(doc.c, nodeErrors)
    const errors = Array.from(rendered.errorMessages || []).join(" | ")
    ec.message.clearErrors()
    return {status: rendered.status, errors, doc, nodeErrors, output: String(rendered.output || "")}
}
let screens

spec({
    setupSpec() {
        lib.ensureUsers()
        ec.user.internalLoginUser(lib.users.admin)
        ec.artifactExecution.enableAuthz()
        screens = sweepScreens()
    },
    cleanupSpec() {
        ec.message.clearErrors()
        ec.user.logoutLocal()
    }
})

feature("every Devices screen and mounted route renders in tui as a model document with no error node", {
    when() {
        const failures = []
        for (const path of screens) {
            const got = tui(path)
            if (got.status != 200 || got.errors) failures.push(`${path}: status ${got.status}, ${got.errors}`)
            else if (!got.doc || got.doc.v != 1) failures.push(`${path}: not a TUI document: ${got.output.substring(0, 160)}`)
            else if (got.nodeErrors.length) failures.push(`${path}: ${got.nodeErrors.join(" | ")}`)
        }
        return {failures: failures.join("\n"), screens}
    },
    then({failures, screens}) {
        screens.length > 20
        screens.includes("Devices/DeviceDetail/Content")
        screens.includes("Groups/GroupDetail/Members")
        screens.includes("Processes/ProcessDetail/Tasks")
        failures == ""
    }
})
