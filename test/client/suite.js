// The Devices app's golden-path walk; other walks belong in test/acceptance/client. The walk starts no device subscription, and
// that property also gives it a server of its own, apart from the components whose fixtures it does not need.
suite(["DevicesWalk"], {
    server: {
        components: ["moqui-device"],
        specs: ["DevicesClientFixtures"],
        properties: {device_gateway_restore_subscriptions: "false"}
    }
})
