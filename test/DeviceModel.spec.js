/*
This software is in the public domain under CC0 1.0 Universal plus a
Grant of Patent License.

To the extent possible under law, the author(s) have dedicated all
copyright and related and neighboring rights to this software to the
public domain worldwide. This software is distributed without any
warranty.

You should have received a copy of the CC0 Public Domain Dedication
along with this software (see the LICENSE.md file). If not, see
<http://creativecommons.org/publicdomain/zero/1.0/>.
*/
const created = []
const GROUP = "DEVICE_MODEL_GROUP"
const SENSOR = "DEVICE_MODEL_SENSOR"
const CONFIG = "DEVICE_MODEL_CONFIG"
const DEF = "DEVICE_MODEL_VALUE"
const REQUEST = "DEVICE_MODEL_READ"

function create(entity, fields) {
    const value = ec.entity.makeValue(entity)
    value.setFields(fields, true, null, null)
    value.create()
    created.push(value)
    return value
}

spec({
    setup() {
        ec.artifactExecution.disableAuthz()
    },
    cleanup() {
        try {
            while (created.length) created.pop().delete()
        } finally {
            ec.artifactExecution.enableAuthz()
        }
    }
})

feature("device specializations remain optional and physical groups follow member identity", {
    when() {
        create("moqui.device.Device", {deviceId: GROUP, deviceTypeEnumId: "DtDeviceGroup"})
        create("moqui.device.DeviceGroup", {deviceId: GROUP, groupName: "Sensor group"})
        create("moqui.device.Device", {deviceId: SENSOR, deviceTypeEnumId: "DtAnalogSensor", parentDeviceId: GROUP})
        const sensor = create("moqui.device.PhysicalDevice", {deviceId: SENSOR, deviceName: "Test sensor"})
        create("moqui.device.DeviceGroupMember", {deviceId: GROUP, memberDeviceId: SENSOR, sequenceNum: 10})
        return {
            group: ec.entity.find("moqui.device.DeviceDetail").condition("deviceId", GROUP).one(),
            sensor: ec.entity.find("moqui.device.DeviceDetail").condition("deviceId", SENSOR).one(),
            members: Array.from(ec.entity.find("moqui.device.DeviceGroupAndMember").condition("deviceId", GROUP).list()),
            groups: Array.from(sensor.findRelated("groups", null, null, false))
        }
    },
    then({group, sensor, members, groups}) {
        group.groupName == "Sensor group"
        group.deviceName == null
        sensor.deviceName == "Test sensor"
        sensor.groupName == null
        members.length == 1
        members[0].memberDeviceId == SENSOR
        groups.length == 1
        groups[0].deviceId == GROUP
        groups[0].memberDeviceId == SENSOR
    }
})

feature("live and recipe parameters share definitions without sharing their values", {
    when() {
        create("moqui.device.Device", {deviceId: SENSOR, deviceTypeEnumId: "DtAnalogSensor"})
        create("moqui.device.PhysicalDevice", {deviceId: SENSOR, deviceName: "Test sensor"})
        create("moqui.device.DeviceConfig", {
            deviceConfigId: CONFIG,
            deviceTypeEnumId: "DtAnalogSensor",
            configName: "TEMPLATE"
        })
        create("moqui.math.ParameterDef", {
            parameterDefId: DEF,
            parameterTypeEnumId: "PtNumberDecimal",
            parameterCode: "measuredValue",
            parameterName: "Measured value"
        })
        const live = create("moqui.math.Parameter", {
            parameterId: "DEVICE_MODEL_LIVE",
            parameterDefId: DEF,
            deviceId: SENSOR,
            numericValue: "12.5",
            sequenceNum: 30
        })
        const recipe = create("moqui.math.Parameter", {
            parameterId: "DEVICE_MODEL_RECIPE",
            parameterDefId: DEF,
            deviceConfigId: CONFIG,
            numericValue: "0"
        })
        create("moqui.device.DeviceRequest", {
            requestName: REQUEST,
            deviceId: SENSOR,
            routerEnumId: "DrrDirect",
            requestTypeEnumId: "DrtRead"
        })
        create("moqui.device.DeviceRequestItem", {
            requestName: REQUEST,
            parameterId: live.parameterId,
            requestItemName: "value",
            sequenceNum: 5
        })
        return {
            live: ec.entity.find("moqui.math.Parameter").condition("parameterId", live.parameterId).one(),
            recipe: ec.entity.find("moqui.math.Parameter").condition("parameterId", recipe.parameterId).one(),
            owner: live.findRelatedOne("device", false),
            config: recipe.findRelatedOne("config", false),
            request: ec.entity.find("moqui.device.DeviceRequest").condition("requestName", REQUEST).one(),
            item: ec.entity.find("moqui.device.DeviceRequestItemDetail").condition("requestName", REQUEST).one()
        }
    },
    then({live, recipe, owner, config, request, item}) {
        live.parameterDefId == recipe.parameterDefId
        live.numericValue.eq("12.5")
        recipe.numericValue.eq(0)
        live.deviceConfigId == null
        recipe.deviceId == null
        owner.deviceId == SENSOR
        config.deviceConfigId == CONFIG
        config.fromDate != null
        request.onlyChangedParameters == "Y"
        request.retained == "N"
        item.parameterId == live.parameterId
        item.sequenceNum == 5
        item.parameterSequenceNum == 30
        item.allowDuplicate == "N"
        item.scalingFactor.eq(1)
        item.offsetValue.eq(0)
        item.tolerance.eq(0)
    }
})

feature("ordered rules can target a group device without a physical device specialization", {
    when() {
        create("moqui.device.Device", {deviceId: GROUP, deviceTypeEnumId: "DtDeviceGroup"})
        create("moqui.device.DeviceGroup", {deviceId: GROUP, groupName: "Logical group"})
        create("moqui.device.DeviceConfig", {
            deviceConfigId: CONFIG,
            deviceTypeEnumId: "DtDeviceGroup",
            configName: "TEMPLATE"
        })
        const set = create("moqui.device.DeviceRuleSet", {
            deviceRuleSetId: "DEVICE_MODEL_RULESET",
            deviceId: GROUP,
            ruleSetName: "Group sequence"
        })
        for (const priority of [20, 10]) {
            create("moqui.device.DeviceRule", {
                deviceRuleId: `DEVICE_MODEL_RULE_${priority}`,
                deviceRuleSetId: set.deviceRuleSetId,
                deviceId: GROUP,
                deviceConfigId: CONFIG,
                ruleName: `Step ${priority}`,
                priority
            })
        }
        const rules = Array.from(set.findRelated("rules", null, ["priority"], false))
        return {
            rules,
            target: rules[0].findRelatedOne("device", false),
            config: rules[0].findRelatedOne("config", false),
            physical: ec.entity.find("moqui.device.PhysicalDevice").condition("deviceId", GROUP).one()
        }
    },
    then({rules, target, config, physical}) {
        rules.length == 2
        rules.map(rule => Number(rule.priority)).join(",") == "10,20"
        rules[0].isEnabled == "Y"
        rules[0].fromDate != null
        target.deviceTypeEnumId == config.deviceTypeEnumId
        physical == null
    }
})
