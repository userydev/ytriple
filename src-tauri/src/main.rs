// Keep the console window hidden on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    ytriple_lib::run()
}
