import globby from 'globby';
import path, {isAbsolute, resolve, join, relative} from 'path';
import fs from 'fs';
// import fetchModules from './fetchModules';

let globalCompilation; // 主要用于`errors.push`
const dependencies = new Set();
const jsonRE = /\/.+\.json$/;

function getPathParse(filePath) {
    return path.parse(filePath);
}

function getFileDir(path) { // must be json file
    return getPathParse(path).dir;
}

function pushError(err) {
    err = typeof err === 'string' ? new Error(err) : err;
    globalCompilation.errors.push(err);
}

function getUsingComponents(content, filePath) {
    try {
        let json = JSON.parse(content);
        return json['usingComponents'] || {}; // 防止返回undefined
    } catch (e) {
        pushError(`${filePath} is not json`);
        return {}; // 解析出错，返回空
    }
}

function addComponents(content, components, parent) {
    components.push(...Object.keys(content).map(name => parent ? path.join(parent, content[name]) : content[name]));
}

function addComponentsFromJson(json, components, parent, filePath) {
    const content = getUsingComponents(json, filePath);
    addComponents(content, components, parent);
}

function addComponentsFromPath(path, components, parent) {
    if (fs.existsSync(path)) {
        let json = fs.readFileSync(path, 'utf8');
        addComponentsFromJson(json, components, parent, path);
    } else {
        pushError(`Component is not found in path "${path}"(not found json)`);
    }
}

function getNativePattern(from, to) {
    return {
        from: getFileDir(from),
        to: getFileDir(to),
        ignore: ['**/*.!(js|json|wxss|wxs|wxml)']
    };
}

function getFilePattern(from, to) {
    return {
        from,
        to,
        ignore: ['**/*.!(js|json|wxss|wxs|wxml)']
    };
}

function generatorPattern(from, to, components, parent) {
    const {dir: fromDir, name: fromName} = getPathParse(from);
    const filePath = `${from}.js`;

    // 为了与小程序保持一致，仅判断`from.js`是否存在
    if (fs.existsSync(filePath)) {
        // 读取需要复制的 js 文件找出其依赖项，并添加到复制项
        dependencies.add(filePath);
        addComponentsFromPath(`${fromDir}/${fromName}.json`, components, getFileDir(parent));
        return getNativePattern(from, to);
    } else {
        pushError(`Component is not found in path "${from}"(not found js)`);
    }
}

function getOutputDir(file, path) {
    const fileDir = getFileDir(file);
    const to = isAbsolute(path)
        ? path
        : join(`${isAbsolute(fileDir) ? fileDir : ('/' + fileDir)}`, path); // 以输出路径为最上级路径

    return to.slice(1);
}

function getEntry(name, code, context) {
    return {
        context,
        assets: {
            [name]: {
                source() {
                    return code;
                }
            }
        }
    };
}

function path2Entry(_path, context) {
    const parse = getPathParse(_path);
    const code = fs.readFileSync(_path, {encoding: 'utf8'});

    if (context) {
        _path = relative(context, _path);
    }
    return getEntry(_path, code, parse.dir);
}

function getAllExtFileFromSrc(src, ext, getEntry) {
    if (!Array.isArray(src)) {
        src = [src];
    }
    return src.reduce((result, dir) => {
        let res = [];
        const stat = fs.statSync(dir);
        if (stat.isDirectory) {
            const jsonPaths = globby.sync(resolve(dir, `**/*.${ext}`));
            res = jsonPaths.map((_path) => getEntry ? path2Entry(_path, dir) : _path);
        } else {
            if (jsonRE.test(dir)) {
                res = [
                    getEntry ? path2Entry(dir) : dir
                ];
            } else {
                pushError(`includes: "${dir}", is not a effective path.`);
            }
        }
        return result.concat(res);
    }, []);
}

function hadExist(patterns, pattern) {
    return patterns.some(p => p.from === pattern.from && p.to === pattern.to);
}

export default function extractComponent(compilation, componentConfig = {}) {
    dependencies.clear();

    globalCompilation = compilation;
    let patterns = [];

    let entries = compilation.entries ? compilation.entries.slice(0) : [];

    let projectContext = (compilation.options || {}).context || '';
    const {src, usingComponents, forceCopy} = componentConfig;

    // 增加对最新版本 mpvue 的支持
    if (src) {
        entries = entries.concat(getAllExtFileFromSrc(src, 'json', true));
    }

    for (let i = 0; i < forceCopy.length; i++) {
        const path = forceCopy[i];
        const to = relative(projectContext, path);
        dependencies.add(path);
        patterns.push(getFilePattern(path, to));
    }

    if (usingComponents) {
        let components = [];
        addComponentsFromPath(usingComponents, components, projectContext);
        for (let j = 0; j < components.length; j++) {
            const path = components[j];
            if (path) {
                const from = path;
                const to = relative(projectContext, path);
                const pattern = generatorPattern(from, to, components, components[j]);
                if (pattern && !hadExist(patterns, pattern)) {
                    patterns.push(pattern);
                }
            }
        }
    }

    if (entries.length && projectContext) {
        for (let i = 0; i < entries.length; i++) {
            let context = entries[i].context;
            let assets = entries[i].assets;

            // 从 assets 获取所有 components 路径
            const file = Object.keys(assets).find(f => jsonRE.test(f));
            let components = [];
            if (file) {
                addComponentsFromJson(assets[file].source(), components, null, file);
            }

            for (let j = 0; j < components.length; j++) {
                const path = components[j];
                if (path) {
                    const from = isAbsolute(path)
                        ? join(projectContext, path)
                        : resolve(projectContext, context, path);

                    const to = getOutputDir(file, path);

                    const pattern = generatorPattern(from, to, components, components[j]);
                    // 重复去重
                    if (pattern && !hadExist(patterns, pattern)) {
                        patterns.push(pattern);
                    }
                }
            }
        }
        // 根据 dependencies 列表得到需要复制的依赖文件
        // patterns = patterns.concat(fetchModules(dependencies, projectContext));
    }
    return patterns;
}
