/*
Copyright 2024 dimden.dev

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

const uWS = require("uWebSockets.js");
const Router = require("./router.js");
const { removeDuplicateSlashes, defaultSettings, compileTrust, createETagGenerator, fastQueryParse, NullObject } = require("./utils.js");
const querystring = require("fast-querystring");
const ViewClass = require("./view.js");
const path = require("path");
const os = require("os");
const { Worker } = require("worker_threads");

const cpuCount = os.cpus().length;

let workers = [];
let taskKey = 0;
const workerTasks = new NullObject();

function createWorker() {
    const worker = new Worker(path.join(__dirname, 'worker.js'));
    workers.push(worker);

    worker.on('message', (message) => {
        if(message.err) {
            workerTasks[message.key].reject(new Error(message.err));
        } else {
            workerTasks[message.key].resolve(message.data);
        }
        delete workerTasks[message.key];
    });
    worker.unref();

    return worker;
}

class Application extends Router {
    constructor(settings = new NullObject()) {
        super(settings);
        if(!settings?.uwsOptions) {
            settings.uwsOptions = {};
        }
        if(typeof settings.threads !== 'number') {
            settings.threads = cpuCount > 1 ? 1 : 0;
        }
        if(settings.uwsOptions.key_file_name && settings.uwsOptions.cert_file_name) {
            this.uwsApp = uWS.SSLApp(settings.uwsOptions);
            this.ssl = true;
        } else {
            this.uwsApp = uWS.App(settings.uwsOptions);
            this.ssl = false;
        }
        this.cache = new NullObject();
        this.engines = {};
        this.locals = {
            settings: this.settings
        };
        this.listenCalled = false;
        this.workers = [];
        for(let i = 0; i < settings.threads; i++) {
            if(workers[i]) {
                this.workers[i] = workers[i];
            } else {
                this.workers[i] = createWorker();
            }
        }
        this.port = undefined;
        for(const key in defaultSettings) {
            if(typeof this.settings[key] === 'undefined') {
                if(typeof defaultSettings[key] === 'function') {
                    this.settings[key] = defaultSettings[key](this);
                } else {
                    this.settings[key] = defaultSettings[key];
                }
            }
        }
        this.set('view', ViewClass);
        this.set('views', path.resolve('views'));
    }

    createWorkerTask(resolve, reject) {
        const key = taskKey++;
        workerTasks[key] = { resolve, reject };
        if(key > 1000000) {
            taskKey = 0;
        }
        return key;
    }

    readFileWithWorker(path) {
        return new Promise((resolve, reject) => {
            const worker = this.workers[Math.floor(Math.random() * this.workers.length)];
            const key = this.createWorkerTask(resolve, reject);
            worker.postMessage({ key, type: 'readFile', path });
        });
    }

    set(key, value) {
        if(key === 'trust proxy') {
            if(!value) {
                delete this.settings['trust proxy fn'];
            } else {
                this.settings['trust proxy fn'] = compileTrust(value);
            }
        } else if(key === 'query parser') {
            if(value === 'extended') {
                this.settings['query parser fn'] = fastQueryParse;
            } else if(value === 'simple') {
                this.settings['query parser fn'] = querystring.parse;
            } else if(typeof value === 'function') {
                this.settings['query parser fn'] = value;
            } else {
                this.settings['query parser fn'] = undefined;
            }
        } else if(key === 'env') {
            if(value === 'production') {
                this.settings['view cache'] = true;
            } else {
                this.settings['view cache'] = undefined;
            }
        } else if(key === 'views') {
            this.settings[key] = path.resolve(value);
            return this;
        } else if(key === 'etag') {
            if(typeof value === 'function') {
                this.settings['etag fn'] = value;
            } else {
                switch(value) {
                    case true:
                    case 'weak':
                        this.settings['etag fn'] = createETagGenerator({ weak: true });
                        break;
                    case 'strong':
                        this.settings['etag fn'] = createETagGenerator({ weak: false });
                        break;
                    case false:
                        delete this.settings['etag fn'];
                        break;
                    default:
                        throw new Error(`Invalid etag mode: ${value}`);
                }
            }
        }

        this.settings[key] = value;
        return this;
    }

    enable(key) {
        this.set(key, true);
        return this;
    }

    disable(key) {
        this.set(key, false);
        return this;
    }

    enabled(key) {
        return !!this.settings[key];
    }

    disabled(key) {
        return !this.settings[key];
    }

    #createRequestHandler() {
        this.uwsApp.any('/*', async (res, req) => {
            const { request, response } = this.handleRequest(res, req);

            const matchedRoute = this._routeRequest(request, response);
            if(!matchedRoute && !response.headersSent && !response.aborted) {
                response.status(404);
                this._sendErrorPage(request, response, `Cannot ${request.method} ${request.path}`, false);
            }
        });
    }

    listen(port, host, callback) {
        this.#createRequestHandler();
        // support listen(callback)
        if(!callback && typeof port === 'function') {
            callback = port;
            port = 0;
        }
        // support listen(port, callback)
        if(typeof host === 'function') {
            callback = host;
            host = undefined;
        }
        const onListen = socket => {
            if(!socket) {
                let err = new Error('Failed to listen on port ' + port + '. No permission or address already in use.');
                throw err;
            }
            this.port = uWS.us_socket_local_port(socket);
            if(callback) callback(this.port);
        };
        let fn = 'listen';
        let args = [];
        if(typeof port !== 'number') {
            if(!isNaN(Number(port))) {
                port = Number(port);
                args.push(port, onListen);
                if(host) {
                    args.unshift(host);
                }
            } else {
                fn = 'listen_unix';
                args.push(onListen, port);
            }
        } else {
            args.push(port, onListen);
            if(host) {
                args.unshift(host);
            }
        }
        this.listenCalled = true;
        this.uwsApp[fn](...args);
        return this.uwsApp;
    }

    address() {
        return { port: this.port };
    }

    path() {
        let paths = [this.mountpath];
        let parent = this.parent;
        while(parent) {
            paths.unshift(parent.mountpath);
            parent = parent.parent;
        }
        let path = removeDuplicateSlashes(paths.join(''));
        return path === '/' ? '' : path;
    }

    engine(ext, fn) {
        if (typeof fn !== 'function') {
            throw new Error('callback function required');
        }
        const extension = ext[0] !== '.'
            ? '.' + ext
            : ext;
        this.engines[extension] = fn;
        return this;
    }

    render(name, options, callback) {
        if(typeof options === 'function') {
            callback = options;
            options = new NullObject();
        }
        if(!options) {
            options = new NullObject();
        } else {
            options = Object.assign({}, options);
        }
        for(let key in this.locals) {
            options[key] = this.locals[key];
        }

        if(options._locals) {
            for(let key in options._locals) {
                options[key] = options._locals[key];
            }
        }

        if(options.cache == null) {
            options.cache = this.enabled('view cache');
        }

        let view;
        if(options.cache) {
            view = this.cache[name];
        }

        if(!view) {
            const View = this.get('view');
            view = new View(name, {
                defaultEngine: this.get('view engine'),
                root: this.get('views'),
                engines: {...this.engines}
            });
            if(!view.path) {
                const dirs = Array.isArray(view.root) && view.root.length > 1
                    ? 'directories "' + view.root.slice(0, -1).join('", "') + '" or "' + view.root[view.root.length - 1] + '"'
                    : 'directory "' + view.root + '"';

                const err = new Error(`Failed to lookup view "${name}" in views ${dirs}`);
                err.view = view;
                return callback(err);
            }

            if(options.cache) {
                this.cache[name] = view;
            }
        }

        try {
            view.render(options, callback);
        } catch(err) {
            callback(err);
        }
    }
}

module.exports = function(options) {
    return new Application(options);
}
