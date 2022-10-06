"use strict";
const https = require('https');

Object.defineProperty(exports, "__esModule", { value: true });
exports.deactivate = exports.activate = void 0;
const gemfile = require("gemfile");
const vscode = require("vscode");
var cache = new Map();
var last_position = null;
class GemfileProvider {
    provideHover(document, position, token) {
        console.log("token :", token)
        last_position = position;
        let gemRange = document.getWordRangeAtPosition(position, /([A-Za-z\/0-9_-]+)(\.[A-Za-z0-9]+)*/);
        if (!gemRange) {
            return;
        }
        console.log(`gemRange${gemRange.start.line}:${gemRange.end.line}`);
        let gem = document.getText(gemRange);
        let lineText = document.lineAt(position.line).text.trim();
        if (lineText.startsWith("//") ||
            lineText.startsWith("#") ||
            lineText.startsWith("source")) {
            return;
        }
        if (!gem || [
            "require",
            "true",
            "false",
            "group",
            "development",
            "test",
            "production",
            "do",
            "gem"
        ].indexOf(gem) !== -1) {
            return;
        }
        if (/^[^a-zA-Z]+$/.test(gem)) {
            console.log("no alphabet");
            return;
        }
        var endpoint;
        let specs = cache.get(document.uri.fsPath);
        let provider = cache.get(document.uri.fsPath + "_GEM_PROVIDER");
        var str = "";
        let url = "";
        let version = "";
        console.log(specs)
        console.log(provider)
        if (gem in specs) {
            version = specs[gem].version;
            endpoint = `${provider}gems/${gem}/versions/${version}`;
        }
        else {
            let src = lineText
                .split(",")[1]
                .replace(/["\s]/g, "")
                .replace(":", ".com");
            let url = `https://${src}`;
            str += `View [${url}](${url})`;
        }
        if (endpoint) {
            console.log("provider: ", provider)
            str += `Current installed version: _${version}_  \n`;
            str += `Gem informations: [${endpoint}](${endpoint})`;
        }
        if (gem in specs) {
            if (!specs[gem].useful_links) {
                let final_str = str;
                return new Promise(resolve => {
                    populate_spec_from_url(endpoint, specs, gem, 3, () => {
                        final_str += "\n\n"
                        Object.entries(specs[gem].useful_infos).map(([info_name, data]) => {
                            final_str += `  \n${info_name}: ${data}`;
                        })
                        Object.entries(specs[gem].useful_links).map(([link_name, url]) => {
                            final_str += `  \n${link_name}: [${url}](${url})`;
                        })
                        let doc = new vscode.MarkdownString(final_str);
                        resolve(new vscode.Hover(doc, gemRange));
                    });
                });
            } else {
                str += "\n\n"
                Object.entries(specs[gem].useful_infos).map(([info_name, data]) => {
                    str += `  \n${info_name}: ${data}`;
                })
                Object.entries(specs[gem].useful_links).map(([link_name, url]) => {
                    str += `  \n${link_name}: [${url}](${url})`;
                })
            }
        }
        let doc = new vscode.MarkdownString(str);
        let link = new vscode.Hover(doc, gemRange);
        return link;
    }
}

function push_useful_links(specs, gem_name, html_page) {
    specs[gem_name]["useful_links"] ||= {};
    specs[gem_name]["useful_infos"] ||= {};
    [{
        html_id: "home",
        target: "Homepage",
    }, {
        html_id: "changelog",
        target: "Changelog",
    }, {
        html_id: "code",
        target: "Repo",
    }].map(({ html_id: html_id, target: target }) => {
        const regexp = new RegExp(` id\=\"${html_id}\" href\=\"(.*)\"`, 'i')
        const url = html_page.match(regexp);
        console.log("--------------------")
        if (url) {
            console.log("add ", gem_name, " a ", target, ": ", url[1])
            specs[gem_name]["useful_links"][target] = url && url[1];
        } else {
            console.log("no ", target, " for ", gem_name)
        }
        console.log("--------------------")
    })
    let last_update_date = html_page.match(/ class\=\"gem__version__date\"\>(.*)\<\//)[1]
    let last_version = html_page.match(/ class\=\"gem__version-wrap\"\>\n(?: )*<a class.*>(.*)<\/a>/)[1]
    specs[gem_name]["useful_infos"]["Last update"] = `${last_update_date} (${last_version})`;
}

function populate_spec_from_url(url, specs, gem_name, retry_left, resolve) {
    if (retry_left <= 0) { return }

    https.get(url, response => {
        response.setEncoding('utf8')
        console.log(response.statusCode);
        if (response.statusCode != "200") {
            setTimeout(() => populate_spec_from_url(url, specs, gem_name, retry_left--, resolve), 1000);
            return;
        }

        const chunks = []
        response.on("data", data => chunks.push(data));
        response.on("end", () => {
            push_useful_links(specs, gem_name, chunks.join(""))
            console.log("0---pushed")
            console.log(specs[gem_name]["useful_links"])
            console.log("RESOLVE!!")
            resolve();
        });
    });

    console.log("get ", url, " in progress")
}

function activate(context) {
    const GemFile = {
        // language: "ruby", may not identical as ruby file so commented this
        pattern: "**/Gemfile",
        scheme: "file"
    };
    var mine_uris = [];
    vscode.workspace
        .findFiles("**/Gemfile.lock")
        .then(uris => {
            mine_uris = uris.map(uri => uri.fsPath.substring(0, uri.fsPath.length - 5));
            return Promise.all(uris.map(uri => gemfile.parse(uri.fsPath)).concat(mine_uris.map(uri => gemfile.parse(uri))));
        })
        .then(infos => {
            console.log("infos: ", infos)
            for (let i in mine_uris) {
                const provider = infos[i].GEM.remote.path;
                const specs = infos[i].GEM.specs;
                const gems = infos[mine_uris.length + i]

                console.log("gems : ", gems)

                console.log("specs ", specs)

                cache.set(mine_uris[i], specs);
                cache.set(mine_uris[i] + "_GEM_PROVIDER", provider);
            }
        });
    let disposable = vscode.languages.registerHoverProvider(GemFile, new GemfileProvider());
    let watcher = vscode.workspace.createFileSystemWatcher("**/Gemfile");
    watcher.onDidChange((uri) => {
        let gem_config = gemfile.parseSync(uri.fsPath).GEM;
        cache.set(uri.fsPath.substring(0, uri.fsPath.length - 5), gem_config.specs);
        cache.set(uri.fsPath.substring(0, uri.fsPath.length - 5) + "_GEM_PROVIDER", gem_config.remove.path);
    });
    context.subscriptions.push(disposable);
}
exports.activate = activate;
function deactivate() {
    cache = null;
}
exports.deactivate = deactivate;
//# sourceMappingURL=extension.js.map