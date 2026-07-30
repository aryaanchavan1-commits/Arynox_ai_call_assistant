package com.callagent.gateway.dialer

object DialString {
    private const val MAX_LENGTH = 64

    fun normalize(input: String): String? {
        val compact = buildString(input.length) {
            input.forEach { char ->
                when {
                    char.isDigit() || char == '*' || char == '#' -> append(char)
                    char == '+' && isEmpty() -> append(char)
                    char.isWhitespace() || char in "()-./" -> Unit
                    else -> return null
                }
            }
        }
        if (compact.isEmpty() || compact.length > MAX_LENGTH) return null
        if (compact == "+" || compact.count { it == '+' } > 1 || compact.indexOf('+') > 0) return null
        return compact
    }
}
