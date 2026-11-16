// The helpers the Devices app's specs share (plan/design-devices.md §6): its spec users, made once, and the calls and renders
// as one of them. The users: a reader (DEVICES), an engineer and an operator (DEVICES with their capability group), a user of no
// Devices group, one with DEVICES_ENGINEER alone (an edit permission that reads nothing), and an administrator (ADMIN).
const users = {
    admin: "devices.spec.admin",
    reader: "devices.spec.reader",
    engineer: "devices.spec.engineer",
    operator: "devices.spec.operator",
    none: "devices.spec.none",
    editOnly: "devices.spec.editonly"
}
const groupsOf = {
    admin: ["ADMIN"],
    reader: ["DEVICES"],
    engineer: ["DEVICES", "DEVICES_ENGINEER"],
    operator: ["DEVICES", "DEVICES_OPERATOR"],
    none: [],
    editOnly: ["DEVICES_ENGINEER"]
}
const app = "moqui.device.DeviceAppServices."

function system(action) {
    const wasDisabled = ec.artifactExecution.disableAuthz()
    try {
        return action()
    } finally {
        if (!wasDisabled) ec.artifactExecution.enableAuthz()
    }
}

// the spec users and their groups, made the first time
function ensureUsers() {
    system(() => {
        for (const key of Object.keys(users)) {
            const userId = "DEVSPEC_" + key.toUpperCase()
            if (ec.entity.find("moqui.security.UserAccount").condition("userId", userId).count()) continue
            ec.entity.makeValue("moqui.security.UserAccount")
                .setAll({userId, username: users[key], userFullName: "Devices spec " + key})
                .create()
            for (const userGroupId of groupsOf[key]) {
                ec.entity.makeValue("moqui.security.UserGroupMember")
                    .setAll({userGroupId, userId, fromDate: ec.user.nowTimestamp})
                    .create()
            }
        }
    })
}

// action as the user, with artifact authorization on; then the user before
function asUser(username, action) {
    const previous = ec.user.username
    ec.user.internalLoginUser(username)
    const disabled = ec.artifactExecution.authzDisabled()
    try {
        ec.artifactExecution.enableAuthz()
        return action()
    } finally {
        ec.message.clearErrors()
        if (disabled) ec.artifactExecution.disableAuthz()
        if (previous) ec.user.internalLoginUser(previous)
        else ec.user.logoutLocal()
    }
}

// the message a call is refused with, or "" when it succeeds; a negative case and a positive case use the same parameters
function refusal(service, parameters = {}) {
    ec.message.pushErrors()
    try {
        ec.service.sync().name(service).parameters(parameters).requireNewTransaction(true).call()
        return ec.message.hasError() ? ec.message.getErrorsString() : ""
    } catch (error) {
        return String(error.message)
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
    }
}

function invoke(service, parameters = {}) {
    return ec.service.sync().name(service).parameters(parameters).call() || {}
}

// a Devices screen as the shell fetches it, a widget's render error counted among the errors
function page(path, parameters = {}, mode = "qvt") {
    const renderer = ec.screen.makeTest().rootScreen("component://moqui-device/screen/Devices.xml").renderMode(mode)
    if (mode === "qvt") renderer.withStaticData()
    const result = renderer.render(path, Object.assign({lastStandalone: "-2"}, parameters), null)
    const output = String(result.output || "")
    const failed = output.match(/(Error rendering|Exception in render)[^\n<]*/g) || []
    const errors = Array.from(result.errorMessages || []).concat(failed)
    ec.message.clearErrors()
    return {status: result.status, output, errors}
}

;({users, app, system, ensureUsers, asUser, refusal, invoke, page})
