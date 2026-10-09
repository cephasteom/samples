const dirTree = require("directory-tree");
const fs = require('fs');

function parseArgs(argv) {
    const args = {
        base: 'https://raw.githubusercontent.com/cephasteom/samples/main/',
        out: './samples.json',
    };
    for (let i = 0; i < argv.length; i += 2) {
        if (argv[i] === '--base') args.base = argv[i + 1];
        if (argv[i] === '--out') args.out = argv[i + 1];
    }
    return args;
}

const { base, out } = parseArgs(process.argv.slice(2));

const tree = dirTree("./samples");

function formatItem(name, url) {
    const ext = name.split(".").pop();
            const segments = url.split("/");
            const group = segments.slice(1, -1).join(".");
            return ['wav', 'mp3', 'flac'].includes(ext)
                ? { group, url }
                : false;
}

function compile(array) {
    return array
        .map(({path, name, children}) => children
            ? compile(children)
            : formatItem(name, path)
        )
        .filter(path => path)
        .flat(128)
}

const result = compile(tree.children)
    .reduce((obj, item) => ({
        ...obj,
        [item.group]: obj[item.group] ? [...obj[item.group], item.url] : [item.url]
    }), {})

const json = JSON.stringify({
    _base: base,
    ...result
});

fs.writeFile(out, json, 'utf8', (err) => {
    err
        ? console.log(`Error writing samples file: ${err}`)
        : console.log(`Samples file is written successfully!`);
});