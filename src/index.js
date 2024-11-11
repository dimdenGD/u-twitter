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
const Application = require("./application.js");
const Router = require("./router.js");
const middlewares = require("./middlewares.js");
const Request = require("./request.js");
const Response = require("./response.js");

try {
    // disable Uwebsockets header
    uWS._cfg('999999990007');
} catch (error) {}

// converts router to a function and makes it callable
Application.Router = function(options) {
    const router = new Router(options);
    const fn = function(req, res, next) {
        const routed = router._routeRequest(req, res, 0);
        if(!routed) {
            next();
        }
    };
    Object.assign(fn, router);
    Object.setPrototypeOf(fn, Object.getPrototypeOf(router));
    return fn;
}

Application.request = Request.prototype;
Application.response = Response.prototype;

Application.static = middlewares.static;

Application.json = middlewares.json;
Application.urlencoded = middlewares.urlencoded;
Application.text = middlewares.text;
Application.raw = middlewares.raw;

module.exports = Application;
