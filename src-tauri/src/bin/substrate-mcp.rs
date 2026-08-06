//! `substrate-mcp` — the MCP door sidecar. An MCP client (Claude
//! Desktop, ChatGPT desktop, an editor) spawns this binary and speaks MCP
//! over stdio; everything real lives in `substrate_lib::mcpdoor`. Exits
//! non-zero before serving when no folders are granted or no vault exists.

fn main() {
    #[cfg(not(mobile))]
    std::process::exit(substrate_lib::mcp_door_main());
    #[cfg(mobile)]
    unreachable!("substrate-mcp is a desktop sidecar");
}
