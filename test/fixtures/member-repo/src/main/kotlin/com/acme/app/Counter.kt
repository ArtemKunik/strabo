package com.acme.app

class Counter {
    private var value: Int = 0
    private val label: String = "counter"
    private var lastError: String = ""

    fun add(delta: Int) {
        value = value + delta
    }

    fun reset() {
        value = 0
        println(label)
    }

    fun fail() {
        lastError = "boom"
    }
}
