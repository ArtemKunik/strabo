package com.acme.app

import com.acme.util.TextList
import com.acme.util.defaultPrefix
import com.acme.util.jsonPrefsStore

class Settings {
    val items: TextList = jsonPrefsStore<String>("settings")
    val prefix: String = defaultPrefix
}
