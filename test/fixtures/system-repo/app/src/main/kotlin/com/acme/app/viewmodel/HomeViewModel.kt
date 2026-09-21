package com.acme.app.viewmodel

import com.acme.app.data.HomeRepository

class HomeViewModel(private val repository: HomeRepository) {
    fun title(): String = repository.load()
}
