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

// The logic of the device services of DeviceServices.xml
const DEVICE = "moqui.device.Device"
const one = (entityName, field, value, cache = false) =>
    ec.entity.find(entityName).condition(field, value).useCache(cache).one()
const list = find => Array.from(find.list() || [])
const refuse = message => {
    ec.message.addError(message)
    return {}
}

// The members of the user groups with the permission, by the dates of the grant and of the membership.
function permissionUsers(userPermissionId) {
    const groupIds = list(
        ec.entity.find("moqui.security.UserGroupPermission").condition("userPermissionId", userPermissionId).useCache(true)
            .conditionDate("fromDate", "thruDate", ec.user.nowTimestamp)
    ).map(row => row.userGroupId)
    if (!groupIds.length) return []
    return list(
        ec.entity.find("moqui.security.UserGroupMember").condition("userGroupId", "in", groupIds)
            .conditionDate("fromDate", "thruDate", ec.user.nowTimestamp)
    ).map(row => row.userId)
}

// send#DeviceNotification: a notice about a Device on a topic of DeviceData.xml, as Mantle's (notify#TaskAssigned,
// Payables.js notify): the message is flat, the Device is the record, the recipients are named (the holders of
// DEVICE_NOTIFY and the userIds given, never the sender) besides the topic's subscribers. A notice that fails is logged;
// the caller's work stands.
function notify(p) {
    const device = one("moqui.device.DeviceDetail", "deviceId", p.deviceId, true)
    if (!device) {
        ec.logger.warn(`Device ${p.deviceId} not found: notification ${p.topic} not sent.`)
        return {}
    }
    const userIds = [...new Set([...permissionUsers("DEVICE_NOTIFY"), ...Array.from(p.userIds || [])])]
        .filter(userId => userId && userId !== ec.user.userId)
    try {
        const notification = ec.makeNotificationMessage()
            .topic(p.topic)
            .message({
                deviceId: device.deviceId,
                deviceName: device.deviceName || device.deviceId,
                requestName: p.requestName || null,
                eventType: p.eventType || null,
                title: p.title,
                text: p.text || p.title
            })
            .record(DEVICE, device.deviceId)
            .reasonEnumId("NrSystem")
        if (ec.user.userId) notification.actorUserId(ec.user.userId)
        if (userIds.length) notification.userIds(userIds)
        notification.send()
        return {notificationMessageId: notification.getNotificationMessageId()}
    } catch (error) {
        ec.logger.error(`Device ${p.deviceId} notification ${p.topic} not sent: ${error && error.message ? error.message : error}`)
        return {}
    }
}

// A field value compared by value: a decimal is an object in the script, so !== would always differ.
function same(a, b) {
    if (a == null || b == null) return a == b
    return typeof a.eq === "function" ? a.eq(b) : String(a) === String(b)
}
// The key that matches a configuration Parameter to a device Parameter.
const parameterKey = parameter => (parameter.parameterDefId || "") + "|" + (parameter.parameterAlias || "")

// The Parameters with a definition by key; the keys found twice are returned apart, since a duplicate is unsafe.
function byKey(parameters) {
    const map = new Map()
    const duplicates = new Set()
    for (const parameter of parameters) {
        if (!parameter.parameterDefId) continue
        const key = parameterKey(parameter)
        if (map.has(key)) duplicates.add(key)
        else map.set(key, parameter)
    }
    return {map, duplicates: [...duplicates].sort()}
}

// apply#DeviceConfig: the declared values of a DeviceConfig copied onto an existing Device, in Moqui only.
function applyConfig(p) {
    const deviceConfigId = p.deviceConfigId
    const deviceId = p.deviceId
    const deviceConfig = one("moqui.device.DeviceConfig", "deviceConfigId", deviceConfigId, true)
    if (!deviceConfig) return refuse(`DeviceConfig not found for deviceConfigId [${deviceConfigId}].`)
    const device = one(DEVICE, "deviceId", deviceId)
    if (!device) return refuse(`Device not found for deviceId [${deviceId}].`)

    if (p.validateDeviceType && deviceConfig.deviceTypeEnumId) {
        const enumResult = ec.service.sync().name("org.moqui.impl.BasicServices.find#EnumerationByParent")
            .parameters({parentEnumId: deviceConfig.deviceTypeEnumId, includeParent: true, includeNested: true,
                orderByField: "description"})
            .call() || {}
        if (!Array.from(enumResult.enumIdSet || []).includes(device.deviceTypeEnumId))
            return refuse(`Device [${deviceId}] with type [${device.deviceTypeEnumId}] is not compatible with DeviceConfig [${deviceConfigId}] type [${deviceConfig.deviceTypeEnumId}].`)
    }

    const updatedDeviceFieldList = []
    if (p.copyDeviceFields) {
        for (const field of ["controlMethodEnumId", "approximatedFunctionId"]) {
            if (!deviceConfig[field] || device[field] === deviceConfig[field]) continue
            updatedDeviceFieldList.push(field)
            if (!p.dryRun) device[field] = deviceConfig[field]
        }
        if (updatedDeviceFieldList.length && !p.dryRun) device.update()
    }

    const sourceParameterList = list(
        ec.entity.find("moqui.math.Parameter").condition("deviceConfigId", deviceConfigId).useCache(true)
    )
    const targetParameterList = list(ec.entity.find("moqui.math.Parameter").condition("deviceId", deviceId))
    const source = byKey(sourceParameterList)
    if (source.duplicates.length)
        return refuse(`DeviceConfig [${deviceConfigId}] has duplicate Parameters for parameterDefId|parameterAlias key(s): ${source.duplicates.join(", ")}. Cannot apply DeviceConfig safely.`)
    const target = byKey(targetParameterList)
    if (target.duplicates.length)
        return refuse(`Device [${deviceId}] has duplicate Parameters for parameterDefId|parameterAlias key(s): ${target.duplicates.join(", ")}. Cannot apply DeviceConfig safely.`)

    const fields = ["numericValue", "symbolicValue", "parameterEnumId"].concat(p.copySequenceNum ? ["sequenceNum"] : [])
    const skipped = new Set()
    const updatedParameterIdList = []
    let commonParameterCount = 0
    for (const [key, sourceParam] of source.map) {
        const targetParam = target.map.get(key)
        if (!targetParam) {
            skipped.add(key)
            continue
        }
        commonParameterCount++
        const changed = fields.filter(field => !same(targetParam[field], sourceParam[field]))
        if (!changed.length) continue
        updatedParameterIdList.push(targetParam.parameterId)
        if (p.dryRun) continue
        for (const field of changed) targetParam[field] = sourceParam[field]
        targetParam.update()
    }
    return {
        sourceParameterCount: sourceParameterList.length,
        targetParameterCount: targetParameterList.length,
        commonParameterCount,
        updatedParameterCount: updatedParameterIdList.length,
        skippedParameterKeySet: [...skipped].sort(),
        updatedParameterIdList,
        updatedDeviceFieldList
    }
}

const nonEmpty = value => (value != null && value !== "" ? String(value) : null)
// a decimal field is a Decimal object in the script: toNumber() reads it
const toNumber = value => (value != null && typeof value.toNumber === "function" ? value.toNumber() : Number(value))
const bufferModes = {PpcmPlcAborting: "0", PpcmPlcBuffered: "1", PpcmPlcBlendingLow: "2", PpcmPlcBlendingPrev: "3",
    PpcmPlcBlendingNext: "4", PpcmPlcBlendingHigh: "5"}
const transitionModes = {PpcmPlcTMNone: "0", PpcmPlcTMCornerDist: "1", PpcmPlcTMConstVel: "2", PpcmPlcTMStartVel: "3",
    PpcmPlcTMMaxVel: "4"}

// The recipe name of a Parameter: the requestItemName of a DeviceRequestItem of the Parameter (the greatest, as the
// gateway query's max()), else by the DeviceConfig type.
function recipeName(parameter, def, deviceName, deviceTypeEnumId) {
    let itemName = null
    for (const item of list(ec.entity.find("moqui.device.DeviceRequestItem").condition("parameterId", parameter.parameterId)))
        if (item.requestItemName != null && (itemName == null || item.requestItemName > itemName)) itemName = item.requestItemName
    const name = nonEmpty(itemName)
    if (name != null) return name
    const alias = nonEmpty(parameter.parameterAlias)
    const type = deviceTypeEnumId || ""
    if (type === "DtPLC") return "dev." + (alias || def.parameterName)
    if (type.startsWith("DtMoquiPlc")) return "dev." + deviceName + "." + (alias || def.parameterName)
    return alias || deviceName + "." + def.parameterName
}

// The trajectory lines of the approximated function of a DeviceConfig; false when a sample has no one-based sequence.
function trajectoryLines(functionId, g) {
    g.lines.push(["Trajectory.trajectoryId", String(functionId)])
    for (const point of list(ec.entity.find("moqui.math.TrajectoryPoint").condition("approximatedFunctionId", functionId))) {
        const sample = ec.entity.find("moqui.math.ApproximatedFunctionSample")
            .condition("approximatedFunctionId", functionId)
            .condition("approximatedFunctionSampleId", point.approximatedFunctionSampleId).one()
        if (!sample) continue
        const sequenceNum = toNumber(sample.sequenceNum)
        if (!Number.isInteger(sequenceNum) || sequenceNum < 1) {
            ec.message.addError("Trajectory recipe samples require positive one-based sequence numbers.")
            return false
        }
        g.pointCount++
        const prefix = `Trajectory.points[${sequenceNum - 1}]`
        if (sample.sampleVectorId)
            for (const component of list(ec.entity.find("moqui.math.VectorComponent").condition("vectorId", sample.sampleVectorId)))
                g.lines.push([`${prefix}.pos.v[${component.dimensionIndex}]`, String(component.realValue)])
        g.lines.push([`${prefix}.sequenceNum`, String(sample.sequenceNum)])
        g.lines.push([`${prefix}.timeOffsetMs`, point.pointTimeOffsetMillis != null ? String(point.pointTimeOffsetMillis) : "0.0"])
        g.lines.push([`${prefix}.isBreakPoint`, point.isBreakPoint === "Y" ? "TRUE" : "FALSE"])
        g.lines.push([`${prefix}.hasBlendingOverride`, point.blendingEnumId != null ? "TRUE" : "FALSE"])
        g.lines.push([`${prefix}.bufferMode`, bufferModes[point.blendingEnumId] ?? "3"])
        g.lines.push([`${prefix}.transitionMode`, transitionModes[point.blendingEnumId] ?? "0"])
        const pathPoint = ec.entity.find("moqui.math.ParametricPathPoint")
            .condition("approximatedFunctionId", functionId)
            .condition("approximatedFunctionSampleId", point.approximatedFunctionSampleId).one()
        g.lines.push([`${prefix}.blendingMode`, pathPoint?.tolerance != null ? String(pathPoint.tolerance) : "0.0"])
    }
    return true
}

// get#DeviceConfigExportFiles: the recipe of a DeviceRuleSet as one text file per DeviceRule priority.
function configExportFiles(p) {
    const ruleSet = one("moqui.device.DeviceRuleSet", "deviceRuleSetId", p.deviceRuleSetId)
    if (!ruleSet) return refuse(`DeviceRuleSet ${p.deviceRuleSetId} not found.`)
    const ruleSetName = ruleSet.ruleSetName || p.deviceRuleSetId

    // priority -> {lines: [[name, value]], parameterKeys: Set, pointCount}
    const groups = new Map()
    const group = priority => {
        const key = priority == null ? 0 : toNumber(priority)
        if (!groups.has(key)) groups.set(key, {lines: [], parameterKeys: new Set(), pointCount: 0})
        return groups.get(key)
    }

    let ruleFind = ec.entity.find("moqui.device.DeviceRule").condition("deviceRuleSetId", p.deviceRuleSetId)
    if (p.deviceId) ruleFind = ruleFind.condition("deviceId", p.deviceId)
    if (p.deviceRuleId) ruleFind = ruleFind.condition("deviceRuleId", p.deviceRuleId)
    for (const rule of list(ruleFind)) {
        if (!rule.deviceConfigId) continue
        const config = one("moqui.device.DeviceConfig", "deviceConfigId", rule.deviceConfigId)
        if (!config) continue
        const physical = rule.deviceId ? one("moqui.device.PhysicalDevice", "deviceId", rule.deviceId) : null
        const deviceName = nonEmpty(physical?.deviceName) || rule.deviceId
        const g = group(rule.priority)

        for (const parameter of list(ec.entity.find("moqui.math.Parameter").condition("deviceConfigId", config.deviceConfigId))) {
            const key = JSON.stringify([parameter.parameterId, deviceName, config.deviceTypeEnumId])
            if (g.parameterKeys.has(key)) continue
            const def = one("moqui.math.ParameterDef", "parameterDefId", parameter.parameterDefId)
            if (!def) continue
            g.parameterKeys.add(key)
            const value = parameter.numericValue != null ? String(parameter.numericValue)
                : parameter.parameterEnumId != null ? parameter.parameterEnumId : parameter.symbolicValue
            g.lines.push([recipeName(parameter, def, deviceName, config.deviceTypeEnumId), value ?? ""])
        }

        if (!config.approximatedFunctionId) continue
        ec.service.sync().name("moqui.device.DeviceServices.get#TrajectoryAxes")
            .parameters({approximatedFunctionId: config.approximatedFunctionId}).call()
        if (ec.message.hasError()) return {}
        if (!trajectoryLines(config.approximatedFunctionId, g)) return {}
    }

    const files = []
    let rowCount = 0
    for (const priority of [...groups.keys()].sort((a, b) => a - b)) {
        const g = groups.get(priority)
        if (g.pointCount > 0) g.lines.push(["Trajectory.pointCount", String(g.pointCount)])
        if (!g.lines.length) continue
        g.lines.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
        files.push({
            name: `${ruleSetName}_p${String(priority).padStart(2, "0")}.txt`,
            content: g.lines.map(([name, value]) => `${name}:=${value}`).join("\n"),
            priority,
            rowCount: g.lines.length
        })
        rowCount += g.lines.length
    }
    return {files, rowCount}
}

const operations = {notify, applyConfig, configExportFiles}
;({
    execute(op, parameters) {
        if (!operations[op]) throw new Error("Unknown device operation " + op)
        return operations[op](parameters)
    }
})
