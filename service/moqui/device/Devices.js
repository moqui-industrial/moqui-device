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

// ========== File transfer ==========

// A transfer error is thrown: the caller records it and tells the user.
const fail = message => { throw new Error(message) }

// The options of a transfer destination: a query string or JSON (DeviceConnection.options, the query of the endpoint).
function destinationOptions(raw, options = {}) {
    const text = raw == null ? "" : String(raw).trim()
    if (!text) return options
    const pairs = text.startsWith("{") ? Object.entries(JSON.parse(text))
        : text.replace(/^\?/, "").split("&").filter(pair => pair).map(pair => {
            const at = pair.indexOf("=")
            return at < 0 ? [decodeURIComponent(pair), ""] : [decodeURIComponent(pair.slice(0, at)), decodeURIComponent(pair.slice(at + 1))]
        })
    for (const [key, value] of pairs) {
        if (key in options) fail("Duplicate transfer option " + key)
        options[key] = value == null ? null : String(value)
    }
    return options
}
const fileName = name => {
    const text = name == null ? "" : String(name)
    if (!text || text === "." || text === ".." || /[\/\\:\u0000-\u001f\u007f]/.test(text)) fail("A transferred file needs a file name, not a path: " + text)
    return text
}
// A credential option, or the environment variable or property that its ...Env option names.
function credential(options, name) {
    const value = options[name], variable = options[name + "Env"]
    if (value != null && variable != null) fail("Set the " + name + " or the " + name + "Env of the destination, not both")
    if (variable == null) return value
    const found = System.getProperty(variable)
    if (found == null) fail("The environment variable " + variable + " of the destination is not set")
    return String(found)
}

// A destination to write files to: file:directory through the resource facade, or sftp://host:port/directory with
// SftpClient (options host-key-fingerprint, required, username and password or private-key-file, each also as ...Env).
// open() connects, write(file) returns where the file went, remove(where) deletes it, close() disconnects.
function destination(spec) {
    let endpoint = nonEmpty(spec.endpoint)
    if (!endpoint) fail("The transfer has no destination: set DeviceRequest.brokerUri or DeviceConnection.transportConfig")
    const options = destinationOptions(spec.options)
    const query = endpoint.indexOf("?")
    if (query >= 0) {
        destinationOptions(endpoint.slice(query + 1), options)
        endpoint = endpoint.slice(0, query)
    }
    if (endpoint.startsWith("file:")) {
        const directory = endpoint.replace(/\/+$/, "")
        return {
            open() {},
            write(file) {
                const location = directory + "/" + file.name
                const reference = ec.resource.getLocationReference(location)
                if (file.bytes) reference.putBytes(file.data)
                else reference.putText(file.data)
                return location
            },
            remove(location) { ec.resource.getLocationReference(location).delete() },
            close() {}
        }
    }
    const sftp = /^sftp:\/\/([^\/:@?#]+)(?::(\d+))?(\/[^?#]*)?$/.exec(endpoint)
    if (!sftp) fail("Unsupported transfer destination " + endpoint + ": use file:directory or sftp://host:port/directory")
    const fingerprint = options["host-key-fingerprint"]
    if (!fingerprint || !fingerprint.startsWith("SHA256:")) fail("SFTP requires a pinned SHA256: host-key-fingerprint")
    const username = credential(options, "username") || credential(options, "userName")
    if (!username) fail("SFTP requires a username")
    const password = credential(options, "password")
    const privateKey = options["private-key-file"]
    if (password == null && !privateKey) fail("SFTP requires a password or a private-key-file")
    const directory = (sftp[3] || "/").replace(/\/+$/, "") || "/"
    const base = "sftp://" + sftp[1] + (sftp[2] ? ":" + sftp[2] : "")
    let client = null
    return {
        open() {
            client = new SftpClient(sftp[1], username, sftp[2] ? Number(sftp[2]) : null)
            client.hostKeyFingerprint(fingerprint)
            if (password != null) client.password(password)
            else client.publicKeyPkcs8(ec.resource.getLocationReference("file:" + privateKey).getText(), null)
            client.connect()
        },
        write(file) {
            client.put(directory, file.name, file.data, null, true)
            return base + (directory === "/" ? "" : directory) + "/" + file.name
        },
        remove(location) { client.rm(location.slice(base.length)) },
        close() {
            if (client != null) client.close()
            client = null
        }
    }
}

// Writes the same files to one destination (endpoint, options) or to several (destinations: maps of endpoint and
// options), in order. files: maps with name and bytes or content (text). All or nothing: every file and destination is
// checked before the first file is written, and when a write fails, every file this transfer wrote, at every
// destination, is deleted, so a device never finds part of a recipe or program set. A file that replaced an older one
// is deleted too. The error names any file that could not be deleted.
function transferFiles(p) {
    const files = Array.from(p.files || []).map(file => {
        if (file.bytes == null && file.content == null) fail("The file " + file.name + " has no bytes or content")
        return {name: fileName(file.name), data: file.bytes != null ? file.bytes : String(file.content), bytes: file.bytes != null}
    })
    if (!files.length) fail("No files to transfer")
    if (new Set(files.map(file => file.name)).size !== files.length) fail("A transfer writes each file name once")
    const targets = Array.from(p.destinations || [{endpoint: p.endpoint, options: p.options}]).map(destination)
    if (!targets.length) fail("The transfer has no destination")
    const written = []
    try {
        for (const target of targets) {
            const done = {target, locations: []}
            written.push(done)
            target.open()
            try {
                for (const file of files) done.locations.push(target.write(file))
            } finally {
                target.close()
            }
        }
    } catch (error) {
        const reason = String(error && error.message || error)
        const left = []
        for (const done of written.reverse()) {
            if (!done.locations.length) continue
            try {
                done.target.open()
                try {
                    for (const location of done.locations.reverse()) {
                        try { done.target.remove(location) } catch (removeError) { left.push(location) }
                    }
                } finally {
                    done.target.close()
                }
            } catch (openError) {
                left.push(...done.locations)
            }
        }
        fail(left.length ? "The transfer failed (" + reason + ") and these files it had written could not be deleted: " + left.join(", ")
            : "The transfer failed and the files it had written were deleted: " + reason)
    }
    return {transferredFiles: written.flatMap(done => done.locations)}
}

const operations = {notify, applyConfig, configExportFiles, transferFiles}
;({
    execute(op, parameters) {
        if (!operations[op]) throw new Error("Unknown device operation " + op)
        return operations[op](parameters)
    }
})
