// The data of the Devices golden walk (test/client/Devices/DevicesWalk), made on the --serve server before the walk: an operator,
// devices.walk.operator (DEVICES and DEVICES_OPERATOR, password "DevicesWalk1!!"), and Virtual PLC 01 running the second task of
// the Test PLC Run Cycle, so that the walk's apply of the first one changes what the header shows.
// Run: ./moq test moqui-device --spec DevicesClientFixtures
const userId = "DEVICES_WALK_OPERATOR"
const find = (entityName, conditions) => ec.entity.find(entityName).condition(conditions).disableAuthz()

spec({
    setupSpec() {
        ec.artifactExecution.disableAuthz()
    },
    cleanupSpec() {
        ec.artifactExecution.enableAuthz()
    }
})

feature("the walk's operator exists and Virtual PLC 01 runs the second task of its process", {
    when() {
        if (!find("moqui.security.UserAccount", {userId}).one()) {
            const user = ec.entity.makeValue("moqui.security.UserAccount")
            user.setAll({userId, username: "devices.walk.operator", userFullName: "Devices Walk Operator"})
            user.create()
            for (const userGroupId of ["DEVICES", "DEVICES_OPERATOR"]) {
                ec.entity.makeValue("moqui.security.UserGroupMember").setAll({userGroupId, userId, fromDate: ec.user.nowTimestamp}).create()
            }
        }
        const password = ec.service.sync().name("org.moqui.impl.UserServices.update#PasswordInternal")
            .parameters({userId, newPassword: "DevicesWalk1!!", newPasswordVerify: "DevicesWalk1!!", requirePasswordChange: "N"})
            .disableAuthz().call()
        ec.service.sync().name("update#moqui.device.Device")
            .parameters({deviceId: "VIRTUAL_PLC_01", deviceRuleSetId: "TestPlcRunRuleSet1", deviceRuleId: "TestPlcRunRule020"})
            .disableAuthz().call()
        return {password: password.updateSuccessful, ruleId: find("moqui.device.Device", {deviceId: "VIRTUAL_PLC_01"}).useCache(false).one().deviceRuleId}
    },
    then(out) {
        out.password == true
        out.ruleId == "TestPlcRunRule020"
    }
})
