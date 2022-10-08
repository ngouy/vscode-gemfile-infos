'use strict';
import * as gemfile from 'gemfile';
import * as vscode from 'vscode';
import * as https from 'https';

// Exports.deactivate = exports.activate = void 0;

let cache = new Map<string, GemfileCache>();
const wordsToIgnore = [
	'require',
	'true',
	'false',
	'group',
	'development',
	'test',
	'production',
	'do',
	'gem',
];

/*
** Types
*/

type GemInfo = {
	title: string;
	isLink: boolean;
	content: string;
};

type GemData = {
	version: string;
	endpoint: string;
	lastAvailableVersion: string;
	infos: GemInfo[];
};

type GemsData = Record<string, GemData>;

type GemfileCache = {
	lockedVersions: GemVersions;
	provider: string;
	gemsData: GemsData;
};

type GemVersions = Record<string, {
	version: string;
}>;

type ParsedGemlock = {
	specs: GemVersions;
	remote: {
		path: string;
	};
};

/*
** Core class
*/

class GemfileProvider implements vscode.HoverProvider {
	public provideHover(
		document: vscode.TextDocument,
		position: vscode.Position,
		_token: vscode.CancellationToken,
	) {
		const nameAndRange = retrieveGemNameAndRange(document, position);
		if (!nameAndRange) {
			return;
		}

		const [gemName, gemRange] = nameAndRange;
		const cacheKey = cacheKeyFor(document.uri.fsPath);
		const gemfileCache = cache.get(cacheKey);
		let gemData = gemfileCache.gemsData[gemName];

		let infobulleStr;

		if (gemData) {
			infobulleStr = formatInfobulleData(gemData);

			const doc = new vscode.MarkdownString(infobulleStr);
			return new vscode.Hover(doc, gemRange);
		}

		if (!gemfileCache.lockedVersions[gemName]) {
			console.error('unknown gem ', gemName);
			return;
		}

		return new Promise((resolve: (value: vscode.Hover) => void) => {
			fetchOnlineData(gemName, cacheKey, 3, () => {
				gemData = gemfileCache.gemsData[gemName];
				infobulleStr = formatInfobulleData(gemData);

				const doc = new vscode.MarkdownString(infobulleStr);
				resolve(new vscode.Hover(doc, gemRange));
			});
		});
	}
}

/*
** Retrieve and populate Data from the web
*/

function fetchOnlineData(gemName: string, cacheKey: string, retry_left: number, resolve: () => any) {
	if (retry_left <= 0) {
		return;
	}

	const gemfileCache = cache.get(cacheKey);
	const {version} = gemfileCache.lockedVersions[gemName];
	const {provider} = gemfileCache;
	const endpoint = `${provider}gems/${gemName}/versions/${version}`;

	https.get(endpoint, response => {
		response.setEncoding('utf8');

		if (response.statusCode !== 200) {
			setTimeout(() => {
				fetchOnlineData(gemName, cacheKey, retry_left--, resolve);
			}, 1000);
			return;
		}

		const chunks = [];
		response.on('data', data => chunks.push(data));
		response.on('end', () => {
			parseDataAndPushToCache(gemName, cacheKey, endpoint, chunks.join(''));
			resolve();
		});
	});
}

function parseDataAndPushToCache(gemName: string, cacheKey: string, endpoint: string, htmlPage: string) {
	const gemfileCache = cache.get(cacheKey);
	const gemData: GemData = {
		version: gemfileCache.lockedVersions[gemName].version,
		lastAvailableVersion: '',
		endpoint,
		infos: [],
	};

	gemfileCache.gemsData[gemName] = gemData;

	// Add Last Update info
	const lastUpdateDate = (/ class="gem__version__date">(.*)<\//.exec(htmlPage))[1];
	const lastVersion = (/ class="gem__version-wrap">\n(?: )*<a class.*>(.*)<\/a>/.exec(htmlPage))[1];
	const versionData: GemInfo = {
		title: 'Last update',
		isLink: false,
		content: `${lastUpdateDate} (${lastVersion})`,
	};
	gemData.infos.push(versionData);
	gemData.lastAvailableVersion = lastVersion;

	// Add useful Links infos
	[{
		htmlId: 'home',
		target: 'Homepage',
	}, {
		htmlId: 'changelog',
		target: 'Changelog',
	}, {
		htmlId: 'code',
		target: 'Repo',
	}].forEach(({htmlId, target}) => {
		const regexp = new RegExp(` id="${htmlId}" href="(.*)"`, 'i');
		const aTagHref = htmlPage.match(regexp);

		if (aTagHref?.[1]) {
			const data: GemInfo = {
				title: target,
				isLink: true,
				content: aTagHref[1],
			};
			gemData.infos.push(data);
		}
	});
}

/*
** Activation related functions
*/

function activate(context: vscode.ExtensionContext) {
	populateCacheOnActivation();
	setupFileWatchers();
	subscribeToGemfileHover(context);
}

function populateCacheOnActivation() {
	vscode.workspace
		.findFiles('**/Gemfile.lock')
		.then(gemfileLockUris => {
			gemfileLockUris.forEach(({fsPath: gemfileLockPath}) => {
				// eslint-disable-next-line @typescript-eslint/no-unsafe-call
				gemfile.parse(gemfileLockPath).then(({GEM}) => {
					refreshFileCache(gemfileLockPath, GEM as ParsedGemlock);
				});
			});
		}, () => {
			console.error('Error while fetching Gemfile.lock files');
		});
}

function setupFileWatchers() {
	const refreshCache = function ({fsPath: filePath}: vscode.Uri) {
		const gemfileLockPath = cacheKeyFor(filePath);
		// eslint-disable-next-line @typescript-eslint/no-unsafe-call
		const parsedGemFileLock = gemfile.parseSync(gemfileLockPath).GEM as ParsedGemlock;
		refreshFileCache(gemfileLockPath, parsedGemFileLock);
	};

	const lockWatcher = vscode.workspace.createFileSystemWatcher('**/Gemfile.lock');
	const watcher = vscode.workspace.createFileSystemWatcher('**/Gemfile');
	lockWatcher.onDidChange(refreshCache);
	watcher.onDidChange(refreshCache);
}

function subscribeToGemfileHover(context: vscode.ExtensionContext) {
	const disposable = vscode.languages.registerHoverProvider(
		{
			// Language: "ruby", may not identical as ruby file so commented this
			pattern: '**/Gemfile',
			scheme: 'file',
		},
		new GemfileProvider(),
	);
	context.subscriptions.push(disposable);
}

/*
** Helpers
*/

// Populate cache for a specific gemfile
function refreshFileCache(gemfileLockPath: string, {specs, remote: {path}}: ParsedGemlock) {
	const cacheKey = cacheKeyFor(gemfileLockPath);
	let gemfileCache: GemfileCache = cache.get(cacheKey);
	const gemDatas: GemsData = {};

	if (gemfileCache) {
		gemfileCache.lockedVersions = specs;
	} else {
		const newCache: GemfileCache = {
			lockedVersions: specs,
			provider: path,
			gemsData: gemDatas,
		};

		cache.set(cacheKey, newCache);
		gemfileCache = cache.get(cacheKey);
	}

	const {lockedVersions} = gemfileCache;

	// Cleanup non matching versions
	Object.keys(gemfileCache.gemsData).forEach((gemName: string) => {
		if (gemName === 'faker') {
			console.log('current cache version ', gemfileCache.gemsData[gemName].version);
			console.log('Lock version ', lockedVersions[gemName].version);
		}

		if (gemfileCache.gemsData[gemName].version !== lockedVersions[gemName].version) {
			// eslint-disable-next-line @typescript-eslint/no-dynamic-delete
			delete gemfileCache.gemsData[gemName];
		}
	});
}

// Format the data for the actual infobulle popup
function formatInfobulleData({version, endpoint, infos, lastAvailableVersion}: GemData): string {
	let result = '';
	const config = vscode.workspace.getConfiguration('vscodeGemfileInfo');

	if (config.showCurrentVersion) {
		result += `Current installed version: _${version}_  `;
		if (lastAvailableVersion === version) {
			result += '🟢  \n';
		} else {
			result += '⏫  \n';
		}
	}

	infos.forEach(({title, isLink, content}) => {
		let configKey = `show${pascalize(title)}`;
		configKey += isLink ? 'Link' : '';

		if (config[configKey]) {
			result += `${title}: `;
			if (isLink) {
				result += `[${content}](${content})`;
			} else {
				result += content;
			}

			result += '  \n';
		}
	});

	if (config.showPackageManagerLink) {
		result += `Gem informations: [${endpoint}](${endpoint})  \n`;
	}

	return result;
}

/* eslint-disable max-statements-per-line, @typescript-eslint/brace-style */
function retrieveGemNameAndRange(
	document: vscode.TextDocument,
	position: vscode.Position,
): [string, vscode.Range] | undefined {
	const gemRange = document.getWordRangeAtPosition(position, /([A-Za-z/0-9_-]+)(\.[A-Za-z0-9]+)*/);
	if (!gemRange) { return; }

	const lineText = document.lineAt(position.line).text.trim();
	if (lineText.startsWith('source')) { return; } // ignore source

	const gemName = document.getText(gemRange);
	if (!gemName || wordsToIgnore.includes(gemName)) { return; } // Gemfile KW
	if (/^[^a-zA-Z]+$/.test(gemName)) { return; } // Empty name

	return [gemName, gemRange];
}
/* eslint-enable max-statements-per-line, @typescript-eslint/brace-style */

function cacheKeyFor(path: string): string {
	return path.endsWith('.lock') ? path : path + '.lock';
}

let cachedPascalizedValuesV2 = {};
function pascalize(str: string): string {
	cachedPascalizedValuesV2[str] ||= (
		str.replace(
			/(\w)(\w*)/g,
			// eslint-disable-next-line
			(_g0, g1, g2) => g1.toUpperCase() + g2.toLowerCase()
		).replace(' ', '')
	);

	// eslint-disable-next-line @typescript-eslint/no-unsafe-return
	return cachedPascalizedValuesV2[str];
}

/*
**
*/

exports.activate = activate;
function deactivate() {
	cache = null;
	cachedPascalizedValuesV2 = null;
}

exports.deactivate = deactivate;
// # sourceMappingURL=extension.js.map
