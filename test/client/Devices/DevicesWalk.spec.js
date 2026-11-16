// The Devices app's golden path in the live client (plan/design-devices.md §6, the app's one regression walk): an operator finds
// Virtual PLC 01, opens it, and applies the first task of its process from the record header's primary action; the header then
// shows the task. The rules (the task's process and device, the permissions) are the server specs DevicesRules and DevicesAccess.
let page = null
spec({
    setupSpec() {
        page = browser.newPage({user: "devices.walk.operator", password: "DevicesWalk1!!", viewport: {width: 1280, height: 1000}, timeout: 30})
        // the suite shell's own calls, which a user of no BOSS app is refused when mr-boss is installed
        page.allowProblems(/userPhoto\?userId=|\/Comms\/Calls\/activeCalls/)
    }
})
function waitForText(text) {
    page.waitFor(text => (document.querySelector(".q-page")?.innerText || "").includes(text), {arg: text})
}
function choose(scope, label, option) {
    scope.getByLabel(label, {exact: true}).click()
    page.getByRole("option", {name: option}).first().click()
    page.keyboard.press("Tab")
}

feature("an operator finds a device, opens it and applies a task", {
    expect() {
        page.goto("/qapps/Devices/Devices/Find").status == 200
        waitForText("Virtual PLC 01")
        page.getByRole("link", {name: "Virtual PLC 01", exact: true}).first().click()
        page.waitForURL(/DeviceDetail/)
        waitForText("Task: Apply PLC production profile")
        page.locator(".m-record-actions").getByRole("button", {name: "Apply task", exact: true}).click()
        const dialog = page.getByRole("dialog")
        choose(dialog, "Process", "Test PLC Run Cycle")
        choose(dialog, "Task", /Apply PLC factory defaults/)
        dialog.getByRole("button", {name: "Apply task", exact: true}).click()
        waitForText("Task: Apply PLC factory defaults")
        page.text().includes("Task: Apply PLC factory defaults")
    }
})
