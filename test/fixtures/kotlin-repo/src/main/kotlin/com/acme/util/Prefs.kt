package com.acme.util

typealias TextList = List<String>

val defaultPrefix = "acme"

private val hiddenPrefix = "secret"

inline fun <reified T : Any> jsonPrefsStore(prefsName: String): List<T> = emptyList()
