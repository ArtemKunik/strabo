package com.acme.app.ui

import com.acme.app.viewmodel.HomeViewModel

class HomeScreen(private val viewModel: HomeViewModel) {
    fun title(): String = viewModel.title()
}
