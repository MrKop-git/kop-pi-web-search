//! 手动验证正文抽取：`cargo run --example extract <file.html>`，输出到 stdout。
fn main() {
    let Some(path) = std::env::args().nth(1) else {
        eprintln!("用法: extract <file.html>");
        std::process::exit(2);
    };
    let html = std::fs::read_to_string(&path).expect("读文件失败");
    print!("{}", pi_web_search_core::text::html_to_text(&html));
}
