"use strict";
/**
 * Start this file by
 *
 * node server.js
 *
 * The script runs 3 core endpoints.
 * http://localhost:3000/content provides an example of the paid content.
 * http://localhost:3001/machinomy accepts payment.
 * http://localhost:3001/verify/:token verifies token that /machinomy generates.
 *
 * The main use case is to buy content:
 *
 * $ machinomy buy http://localhost:3000/content
 *
 * The command shows the bought content on console.
 *
 * Then you can see channels:
 *
 * $ machinomy channels
 *
 * And if you wants to close channel, call `/claim` endpoint via curl:
 *
 * $ curl -X POST http://localhost:3001/claim/:channeId
 */
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : new P(function (resolve) { resolve(result.value); }).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g;
    return g = { next: verb(0), "throw": verb(1), "return": verb(2) }, typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (_) try {
            if (f = 1, y && (t = y[op[0] & 2 ? "return" : op[0] ? "throw" : "next"]) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [0, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
var _this = this;
exports.__esModule = true;
var express = require("express");
var Web3 = require("web3");
var index_1 = require("../node_modules/machinomy/dist/index");
var bodyParser = require("body-parser");
var client_1 = require("../node_modules/machinomy/dist/lib/client");
var payment_channel_1 = require("../node_modules/machinomy/dist/lib/payment_channel");
var fetch = require('whatwg-fetch').fetch;
/**
 * Account that receives payments.
 */
var receiver = '0xa1029eba3e863423e324e8ae8851e91598435505';
const HDWalletProvider = require('truffle-hdwallet-provider')
const provider = new HDWalletProvider(process.env.SECRET, process.env.RINKEBY_PROVIDER_URL)
var web3 = new Web3(provider);
/**
 * Create machinomy instance that provides API for accepting payments.
 */
var machinomy = new index_1["default"](receiver, web3, { databaseUrl: 'nedb://./machinomy_server' });
var hub = express();
hub.use(bodyParser.json());
hub.use(bodyParser.urlencoded({ extended: false }));
/**
 * Recieve an off-chain payment issued by `machinomy buy` command.
 */
hub.post('/machinomy', function (req, res, next) { return __awaiter(_this, void 0, void 0, function () {
    var body;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0: return [4 /*yield*/, machinomy.acceptPayment(req.body)];
            case 1:
                body = _a.sent();
                res.status(202).header('Paywall-Token', body.token).send(body);
                return [2 /*return*/];
        }
    });
}); });
/**
 * Verify the token that `/machinomy` generates.
 */
hub.get('/verify/:token', function (req, res, next) {
    var token = req.params.token;
    machinomy.acceptToken(client_1.AcceptTokenRequestSerde.instance.deserialize({
        token: token
    })).then(function () { return res.status(200).send({ status: 'ok' }); })["catch"](function () { return res.status(400).send({ status: 'token is invalid' }); });
});
hub.get('/channels', function (req, res, next) { return __awaiter(_this, void 0, void 0, function () {
    var channels;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0: return [4 /*yield*/, machinomy.channels()];
            case 1:
                channels = _a.sent();
                res.status(200).send(channels.map(payment_channel_1.PaymentChannelSerde.instance.serialize));
                return [2 /*return*/];
        }
    });
}); });
hub.get('/claim/:channelid', function (req, res, next) { return __awaiter(_this, void 0, void 0, function () {
    var channelId, error_1;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0:
                _a.trys.push([0, 2, , 3]);
                channelId = req.params.channelid;
                return [4 /*yield*/, machinomy.close(channelId)];
            case 1:
                _a.sent();
                res.status(200).send('Claimed');
                return [3 /*break*/, 3];
            case 2:
                error_1 = _a.sent();
                res.status(404).send('No channel found');
                console.log(error_1);
                return [3 /*break*/, 3];
            case 3: return [2 /*return*/];
        }
    });
}); });
var port = 3001;
hub.listen(port, function () {
    console.log('HUB is ready on port ' + port);
});
var app = express();
var paywallHeaders = function () {
    var headers = {};
    headers['Paywall-Version'] = '0.0.3';
    headers['Paywall-Price'] = '1000';
    headers['Paywall-Address'] = receiver;
    headers['Paywall-Gateway'] = 'http://localhost:3001/machinomy';
    return headers;
};
/**
 * Example of serving a paid content. You can buy it with `machinomy buy http://localhost:3000/content` command.
 */
app.get('/content', function (req, res, next) { return __awaiter(_this, void 0, void 0, function () {
    var reqUrl, content, token, response, json, status_1;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0:
                reqUrl = 'http://localhost:3001/verify';
                content = req.get('authorization');
                if (!content) return [3 /*break*/, 3];
                token = content.split(' ')[1];
                return [4 /*yield*/, fetch(reqUrl + '/' + token)];
            case 1:
                response = _a.sent();
                return [4 /*yield*/, response.json()];
            case 2:
                json = _a.sent();
                status_1 = json.status;
                if (status_1 === 'ok') {
                    res.send('Thank you for your purchase');
                }
                else {
                    res.status(402).set(paywallHeaders()).send('Content is not avaible');
                }
                return [3 /*break*/, 4];
            case 3:
                res.status(402).set(paywallHeaders()).send('Content is not avaible');
                _a.label = 4;
            case 4: return [2 /*return*/];
        }
    });
}); });
var portApp = 3000;
app.listen(portApp, function () {
    console.log('Content proveder is ready on ' + portApp);
});
