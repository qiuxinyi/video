/*! @license
 * Shaka Player
 * Copyright 2016 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

goog.provide('shaka.net.NetworkingEngine');
goog.provide('shaka.net.NetworkingEngine.RequestType');
goog.provide('shaka.net.NetworkingEngine.PendingRequest');

goog.requireType('shaka.Player');
goog.require('shaka.media.TimeRangesUtils');
goog.require('goog.Uri');
goog.require('goog.asserts');
goog.require('shaka.net.Backoff');
goog.require('shaka.util.AbortableOperation');
goog.require('shaka.util.BufferUtils');
goog.require('shaka.util.Error');
goog.require('shaka.util.FakeEvent');
goog.require('shaka.util.FakeEventTarget');
goog.require('shaka.util.IDestroyable');
goog.require('shaka.util.ObjectUtils');
goog.require('shaka.util.OperationManager');
goog.require('shaka.util.Timer');


/**
 * @event shaka.net.NetworkingEngine.RetryEvent
 * @description Fired when the networking engine receives a recoverable error
 *   and retries.
 * @property {string} type
 *   'retry'
 * @property {?shaka.util.Error} error
 *   The error that caused the retry. If it was a non-Shaka error, this is set
 *   to null.
 * @exportDoc
 */


/**
 * NetworkingEngine wraps all networking operations.  This accepts plugins that
 * handle the actual request.  A plugin is registered using registerScheme.
 * Each scheme has at most one plugin to handle the request.
 *
 * @implements {shaka.util.IDestroyable}
 * @export
 */
shaka.net.NetworkingEngine = class extends shaka.util.FakeEventTarget {
  /**
   * @param {function(number, number)=} onProgressUpdated Called when a progress
   *   event is triggered. Passed the duration, in milliseconds, that the
   *   request took, and the number of bytes transferred.
   * @param {shaka.net.NetworkingEngine.OnHeadersReceived=} onHeadersReceived
   *   Called when the headers are received for a download.
   * @param {shaka.net.NetworkingEngine.OnDownloadFailed=} onDownloadFailed
   *   Called when a download fails, for any reason.
   * @param {shaka.Player=} pInterface
   *   yec add it
   */
  constructor(
      onProgressUpdated,
      onHeadersReceived,
      onDownloadFailed,
      pInterface) {
    super();

    /** @private {?shaka.Player} */
    this.playerInterface_ = pInterface || null;

    /** @private {boolean} */
    this.destroyed_ = false;

    /** @private {!shaka.util.OperationManager} */
    this.operationManager_ = new shaka.util.OperationManager();

    /** @private {!Set.<shaka.extern.RequestFilter>} */
    this.requestFilters_ = new Set();

    /** @private {!Set.<shaka.extern.ResponseFilter>} */
    this.responseFilters_ = new Set();

    /** @private {?function(number, number)} */
    this.onProgressUpdated_ = onProgressUpdated || null;

    /** @private {?shaka.net.NetworkingEngine.OnHeadersReceived} */
    this.onHeadersReceived_ = onHeadersReceived || null;

    /** @private {?shaka.net.NetworkingEngine.OnDownloadFailed} */
    this.onDownloadFailed_ = onDownloadFailed || null;

    /** @private {boolean} */
    this.forceHTTPS_ = false;

    /** @public {number} */
    this.qoeaddcounter = 0;

    /** @public {number} */
    this.myqoe = 7;
  }

  /**
   * @param {boolean} forceHTTPS
   * @export
   */
  setForceHTTPS(forceHTTPS) {
    this.forceHTTPS_ = forceHTTPS;
  }

  /**
   * Registers a scheme plugin.  This plugin will handle all requests with the
   * given scheme.  If a plugin with the same scheme already exists, it is
   * replaced, unless the existing plugin is of higher priority.
   * If no priority is provided, this defaults to the highest priority of
   * APPLICATION.
   *
   * @param {string} scheme 这个好像就是用来进行发送fetch请求的
   * @param {shaka.extern.SchemePlugin} plugin
   * @param {number=} priority
   * @param {boolean=} progressSupport
   * @export
   */
  static registerScheme(scheme, plugin, priority, progressSupport = false) {
    goog.asserts.assert(
        priority == undefined || priority > 0, 'explicit priority must be > 0');
    priority =
        priority || shaka.net.NetworkingEngine.PluginPriority.APPLICATION;
    const existing = shaka.net.NetworkingEngine.schemes_[scheme];
    if (!existing || priority >= existing.priority) {
      shaka.net.NetworkingEngine.schemes_[scheme] = {
        priority: priority,
        plugin: plugin,
        progressSupport: progressSupport,
      };
    }
  }

  /**
   * Removes a scheme plugin.
   *
   * @param {string} scheme
   * @export
   */
  static unregisterScheme(scheme) {
    delete shaka.net.NetworkingEngine.schemes_[scheme];
  }

  /**
   * Registers a new request filter.  All filters are applied in the order they
   * are registered.
   *
   * @param {shaka.extern.RequestFilter} filter
   * @export
   */
  registerRequestFilter(filter) {
    this.requestFilters_.add(filter);
  }

  /**
   * Removes a request filter.
   *
   * @param {shaka.extern.RequestFilter} filter
   * @export
   */
  unregisterRequestFilter(filter) {
    this.requestFilters_.delete(filter);
  }

  /**
   * Clears all request filters.
   *
   * @export
   */
  clearAllRequestFilters() {
    this.requestFilters_.clear();
  }

  /**
   * Registers a new response filter.  All filters are applied in the order they
   * are registered.
   *
   * @param {shaka.extern.ResponseFilter} filter
   * @export
   */
  registerResponseFilter(filter) {
    this.responseFilters_.add(filter);
  }

  /**
   * Removes a response filter.
   *
   * @param {shaka.extern.ResponseFilter} filter
   * @export
   */
  unregisterResponseFilter(filter) {
    this.responseFilters_.delete(filter);
  }

  /**
   * Clears all response filters.
   *
   * @export
   */
  clearAllResponseFilters() {
    this.responseFilters_.clear();
  }

  /**
   * Gets a copy of the default retry parameters.
   *
   * @return {shaka.extern.RetryParameters}
   *
   * NOTE: The implementation moved to shaka.net.Backoff to avoid a circular
   * dependency between the two classes.
   *
   * @export
   */
  static defaultRetryParameters() {
    return shaka.net.Backoff.defaultRetryParameters();
  }

  /**
   * Makes a simple network request for the given URIs.
   *
   * @param {!Array.<string>} uris
   * @param {shaka.extern.RetryParameters} retryParams
   * @param {?function(BufferSource):!Promise=} streamDataCallback
   * @return {shaka.extern.Request}
   * @export
   */
  static makeRequest(uris, retryParams, streamDataCallback = null) {
    return {
      uris: uris,
      method: 'GET',
      body: null,
      headers: {},
      allowCrossSiteCredentials: false,
      retryParameters: retryParams,
      licenseRequestType: null,
      sessionId: null,
      streamDataCallback: streamDataCallback,
    };
  }

  /**
   * @override
   * @export
   */
  destroy() {
    this.destroyed_ = true;
    this.requestFilters_.clear();
    this.responseFilters_.clear();
    return this.operationManager_.destroy();
  }

  /**
   * Makes a network request and returns the resulting data.
   *在这个函数中进行网络请求
   * @param {shaka.net.NetworkingEngine.RequestType} type
   * @param {shaka.extern.Request} request
   * @return {!shaka.net.NetworkingEngine.PendingRequest}
   * @export
   */
  request(type, request) {
    const ObjectUtils = shaka.util.ObjectUtils;
    const numBytesRemainingObj =
        new shaka.net.NetworkingEngine.NumBytesRemainingClass();

    // Reject all requests made after destroy is called.
    if (this.destroyed_) {
      const p = Promise.reject(new shaka.util.Error(
          shaka.util.Error.Severity.CRITICAL,
          shaka.util.Error.Category.PLAYER,
          shaka.util.Error.Code.OPERATION_ABORTED));
      // Silence uncaught rejection errors, which may otherwise occur any place
      // we don't explicitly handle aborted operations.
      p.catch(() => {});
      return new shaka.net.NetworkingEngine.PendingRequest(
          p, () => Promise.resolve(), numBytesRemainingObj);
    }

    goog.asserts.assert(
        request.uris && request.uris.length, 'Request without URIs!');

    // If a request comes from outside the library, some parameters may be left
    // undefined.  To make it easier for application developers, we will fill
    // them in with defaults if necessary.
    //
    // We clone retryParameters and uris so that if a filter modifies the
    // request, it doesn't contaminate future requests.
    request.method = request.method || 'GET';
    request.headers = request.headers || {};
    request.retryParameters = request.retryParameters ?
        ObjectUtils.cloneObject(request.retryParameters) :
        shaka.net.NetworkingEngine.defaultRetryParameters();
    request.uris = ObjectUtils.cloneObject(request.uris);
    // Apply the registered filters to the request.每次进行请求的时候都会需要先过一遍
    // filter，同样的，response回来的时候也会经过各个response filter
    const requestFilterOperation = this.filterRequest_(type, request);
    // 这里进行请求的发送
    const requestOperation = requestFilterOperation.chain(
        () => this.makeRequestWithRetry_(type, request, numBytesRemainingObj));
    const responseFilterOperation = requestOperation.chain(
        (responseAndGotProgress) =>
          this.filterResponse_(type, responseAndGotProgress));

    // Keep track of time spent in filters.
    const requestFilterStartTime = Date.now();
    let requestFilterMs = 0;
    requestFilterOperation.promise.then(() => {
      requestFilterMs = Date.now() - requestFilterStartTime;
    }, () => {});  // Silence errors in this fork of the Promise chain.

    let responseFilterStartTime = 0;
    requestOperation.promise.then(() => {
      responseFilterStartTime = Date.now();
    }, () => {});  // Silence errors in this fork of the Promise chain.

    const op = responseFilterOperation.chain((responseAndGotProgress) => {
      const responseFilterMs = Date.now() - responseFilterStartTime;
      const response = responseAndGotProgress.response;
      response.timeMs += requestFilterMs;
      response.timeMs += responseFilterMs;
      if (!responseAndGotProgress.gotProgress &&
          this.onProgressUpdated_ &&
          !response.fromCache &&
          type == shaka.net.NetworkingEngine.RequestType.SEGMENT) {
        this.onProgressUpdated_(response.timeMs, response.data.byteLength);
      }
      return response;
    }, (e) => {
      // Any error thrown from elsewhere should be recategorized as CRITICAL
      // here.  This is because by the time it gets here, we've exhausted
      // retries.
      if (e) {
        goog.asserts.assert(e instanceof shaka.util.Error, 'Wrong error type');
        e.severity = shaka.util.Error.Severity.CRITICAL;
      }

      throw e;
    });

    // Return the pending request, which carries the response operation, and the
    // number of bytes remaining to be downloaded, updated by the progress
    // events.  Add the operation to the manager for later cleanup.
    const pendingRequest =
        new shaka.net.NetworkingEngine.PendingRequest(
            op.promise, () => op.abort(), numBytesRemainingObj);
    this.operationManager_.manage(pendingRequest);
    return pendingRequest;
  }

  /**
   * @param {shaka.net.NetworkingEngine.RequestType} type
   * @param {shaka.extern.Request} request
   * @return {!shaka.util.AbortableOperation.<undefined>}
   * @private
   */
  filterRequest_(type, request) {
    let filterOperation = shaka.util.AbortableOperation.completed(undefined);

    for (const requestFilter of this.requestFilters_) {
      // Request filters are run sequentially.
      filterOperation = filterOperation.chain(() => {
        if (request.body) {
          // TODO: For v4.0 we should remove this or change to always pass a
          // Uint8Array.  To make it easier for apps to write filters, it may be
          // better to always pass a Uint8Array so they know what they are
          // getting; but we shouldn't use ArrayBuffer since that would require
          // copying buffers if this is a partial view.
          request.body = shaka.util.BufferUtils.toArrayBuffer(request.body);
        }
        return requestFilter(type, request);
      });
    }

    // Catch any errors thrown by request filters, and substitute
    // them with a Shaka-native error.
    return filterOperation.chain(undefined, (e) => {
      if (e instanceof shaka.util.Error &&
          e.code == shaka.util.Error.Code.OPERATION_ABORTED) {
        // Don't change anything if the operation was aborted.
        throw e;
      }

      throw new shaka.util.Error(
          shaka.util.Error.Severity.CRITICAL,
          shaka.util.Error.Category.NETWORK,
          shaka.util.Error.Code.REQUEST_FILTER_ERROR, e);
    });
  }

  /**
   * @param {shaka.net.NetworkingEngine.RequestType} type
   * @param {shaka.extern.Request} request
   * @param {shaka.net.NetworkingEngine.NumBytesRemainingClass}
   *            numBytesRemainingObj
   * @return {!shaka.extern.IAbortableOperation.<
   *            shaka.net.NetworkingEngine.ResponseAndGotProgress>}
   * @private
   */
  makeRequestWithRetry_(type, request, numBytesRemainingObj) {
    const backoff = new shaka.net.Backoff(
        request.retryParameters, /* autoReset= */ false);
    const index = 0;
    return this.send_(
        type, request, backoff, index, /* lastError= */ null,
        numBytesRemainingObj);
  }

  /**
   * Sends the given request to the correct plugin and retry using Backoff.
   *
   * @param {shaka.net.NetworkingEngine.RequestType} type
   * @param {shaka.extern.Request} request
   * @param {!shaka.net.Backoff} backoff
   * @param {number} index
   * @param {?shaka.util.Error} lastError
   * @param {shaka.net.NetworkingEngine.NumBytesRemainingClass}
   *     numBytesRemainingObj
   * @return {!shaka.extern.IAbortableOperation.<
   *               shaka.net.NetworkingEngine.ResponseAndGotProgress>}
   * @private
   */
  send_(type, request, backoff, index, lastError, numBytesRemainingObj) {
    // yec add
    // yec take place
    const myplayerinterface = this.playerInterface_;
    console.log('mynotcut', request.uris[index]);
    request.uris[index]=request.uris[index].split('?')[0];
    console.log('newindex', index);
    console.log('newflowid', myplayerinterface.flowid);
    const playeruri = myplayerinterface.getAssetUri();
    const myvideo = myplayerinterface.mygetVideo();
    const bufferLead = shaka.media.TimeRangesUtils.bufferedAheadOf(
        myvideo.buffered,
        myvideo.currentTime);
    let mywidth = myvideo['width'];
    let myheight = myvideo['height'];
    if (mywidth == 0 && myheight == 0) {
      // 没有指定长和宽，那么就是视频的长和宽(分辨率)
      mywidth = myvideo['videoWidth'];
      myheight = myvideo['videoHeight'];
    }
    if (mywidth == 0 && myheight != 0) {
      // 指定了宽没指定长,我们默认采取16:9
      mywidth = myheight/9*16;
    }
    if (mywidth != 0 && myheight == 0) {
      // 指定了长没指定宽,我们默认采取16:9
      myheight = mywidth/16*9;
    }
    // 判断结束
    // 打印出来看一看
    console.log('newmywidth', mywidth);
    console.log('newmyheight', myheight);
    const judge = playeruri.split('/').pop().split('.')[0];
    let mytype = 0;
    let targetrate = 0;
    if (judge == 'action') {
      // action
      if (myheight >= 1440) {
        mytype = 1;
        // exp((2000*x)/4891 + 88652/24455)
        targetrate = Math.exp((2000*this.myqoe)/4891+88652/24455)*1024;
      }
      if (myheight >= 1080 && myheight < 1440) {
        mytype = 2;
        // exp((10000*x)/16611 + 16049/5537)
        targetrate = Math.exp((10000*this.myqoe)/16611+16049/5537)*1024;
      }
      if (myheight < 1080) {
        mytype = 3;
        // exp((10000*x)/16927 + 45966/16927)
        targetrate = Math.exp((10000*this.myqoe)/16927+45966/16927)*1024;
      }
    }
    if (judge == 'food') {
      // foods
      if (myheight >= 1440) {
        // exp((5000*x)/12161 + 40761/12161)
        mytype = 4;
        targetrate = Math.exp((5000*this.myqoe)/12161+40761/12161)*1024;
      }
      if (myheight >= 1080 && myheight < 1440) {
        mytype = 5;
        // exp((2000*x)/3487 + 51723/17435)
        targetrate = Math.exp((2000*this.myqoe)/3487+51723/17435)*1024;
      }
      if (myheight < 1080) {
        mytype = 6;
        // exp((10000*x)/20071 + 58200/20071)
        targetrate = Math.exp((10000*this.myqoe)/20071+58200/20071)*1024;
      }
    }
    if (judge == 'bbb') {
      // cartoons
      if (myheight >= 1440) {
        mytype = 7;
        // exp((10000*x)/18509 + 48633/18509)
        targetrate = Math.exp((10000*this.myqoe)/18509+48633/18509)*1024;
      }
      if (myheight >= 1080 && myheight < 1440) {
        mytype = 8;
        // exp((10000*x)/18749 + 61618/18749)
        targetrate = Math.exp((10000*this.myqoe)/18749+61618/18749)*1024;
      }
      if (myheight < 1080) {
        mytype = 9;
        // exp((10000*x)/17551 + 50058/17551)
        targetrate = Math.exp((10000*this.myqoe)/17551+50058/17551)*1024;
      }
    }
    if (judge == 'sports') {
      // sports
      if (myheight >= 1440) {
        mytype = 10;
        // exp((2500*x)/5219 + 77861/20876)
        targetrate = Math.exp((2500*this.myqoe)/5219+77861/20876)*1024;
      }
      if (myheight >= 1080 && myheight < 1440) {
        mytype = 11;
        // exp((5000*x)/8309 + 29776/8309)
        targetrate = Math.exp((5000*this.myqoe)/8309+29776/8309)*1024;
      }
      if (myheight < 1080) {
        mytype = 12;
        // exp((5000*x)/8271 + 26461/8271)
        targetrate = Math.exp((5000*this.myqoe)/8271+26461/8271)*1024;
      }
    }
    console.log('newmytype', mytype);
    // qoe逻辑
    // 带宽大于target_rate,使用单位bit/s，qoe加法逻辑
    let mybandwidth=0;
    if (myplayerinterface.mygetabr()!=null) {
      mybandwidth=myplayerinterface.mygetabr().getBandwidthEstimate();
    }
    console.log('newmybandwidth', mybandwidth);
    if (mybandwidth >= targetrate) {
      // 如果qoe加法计数器大于等于1，则增加qoe
      if (this.qoeaddcounter >= 1) {
        this.myqoe = Math.min(this.myqoe+1, 9);
        this.qoeaddcounter = 0;
      } else {
        // 如果qoe加法计数器为0，计数+1
        this.qoeaddcounter++;
      }
    } else {
      this.myqoe = Math.max(5, this.myqoe-1);
    }
    console.log('qoeaddcounter', this.qoeaddcounter);
    console.log('myqoe', this.myqoe);
    // 添加信息
    const buffermode = bufferLead > 5 ? 2 : 1;
    let myaddinfo='?flowid='+myplayerinterface.flowid.toString();
    myaddinfo+='&mode='+buffermode.toString();
    myaddinfo+='&player_type='+mytype.toString();
    myaddinfo+='&target_rate='+targetrate.toString();
    request.uris[index]+=myaddinfo+'&debug='+bufferLead.toString();
    console.log('myadddebug', request.uris[index]);
    if (this.forceHTTPS_) {
      request.uris[index] = request.uris[index].replace('http://', 'https://');
    }

    const uri = new goog.Uri(request.uris[index]);
    let scheme = uri.getScheme();
    // Whether it got a progress event.
    let gotProgress = false;
    if (!scheme) {
      // If there is no scheme, infer one from the location.
      scheme = shaka.net.NetworkingEngine.getLocationProtocol_();
      goog.asserts.assert(
          scheme[scheme.length - 1] == ':',
          'location.protocol expected to end with a colon!');
      // Drop the colon.
      scheme = scheme.slice(0, -1);

      // Override the original URI to make the scheme explicit.
      uri.setScheme(scheme);
      request.uris[index] = uri.toString();
    }

    // Schemes are meant to be case-insensitive.
    // See https://github.com/google/shaka-player/issues/2173
    // and https://tools.ietf.org/html/rfc3986#section-3.1
    scheme = scheme.toLowerCase();

    const object = shaka.net.NetworkingEngine.schemes_[scheme];
    const plugin = object ? object.plugin : null;
    if (!plugin) {
      return shaka.util.AbortableOperation.failed(
          new shaka.util.Error(
              shaka.util.Error.Severity.CRITICAL,
              shaka.util.Error.Category.NETWORK,
              shaka.util.Error.Code.UNSUPPORTED_SCHEME,
              uri));
    }
    const progressSupport = object.progressSupport;


    // Every attempt must have an associated backoff.attempt() call so that the
    // accounting is correct.
    const backoffOperation =
        shaka.util.AbortableOperation.notAbortable(backoff.attempt());

    /** @type {?shaka.util.Timer} */
    let connectionTimer = null;

    /** @type {?shaka.util.Timer} */
    let stallTimer = null;

    let aborted = false;

    let headersReceivedCalled = false;

    let startTimeMs;
    const sendOperation = backoffOperation.chain(() => {
      if (this.destroyed_) {
        return shaka.util.AbortableOperation.aborted();
      }

      startTimeMs = Date.now();
      // 表示这个函数只是用来获取segment的
      const segment = shaka.net.NetworkingEngine.RequestType.SEGMENT;

      const progressUpdated = (time, bytes, numBytesRemaining) => {
        if (connectionTimer) {
          connectionTimer.stop();
        }
        if (stallTimer) {
          stallTimer.tickAfter(stallTimeoutMs / 1000);
        }
        if (this.onProgressUpdated_ && type == segment) {
          this.onProgressUpdated_(time, bytes);
          gotProgress = true;
          numBytesRemainingObj.setBytes(numBytesRemaining);
        }
      };
      const headersReceived = (headers) => {
        if (this.onHeadersReceived_) {
          this.onHeadersReceived_(headers, request, type);
        }
        headersReceivedCalled = true;
      };
      const requestPlugin = plugin(
          request.uris[index], request, type, progressUpdated, headersReceived);

      if (!progressSupport) {
        return requestPlugin;
      }

      const connectionTimeoutMs = request.retryParameters.connectionTimeout;
      if (connectionTimeoutMs) {
        connectionTimer = new shaka.util.Timer(() => {
          aborted = true;
          requestPlugin.abort();
        });

        connectionTimer.tickAfter(connectionTimeoutMs / 1000);
      }

      const stallTimeoutMs = request.retryParameters.stallTimeout;
      if (stallTimeoutMs) {
        stallTimer = new shaka.util.Timer(() => {
          aborted = true;
          requestPlugin.abort();
        });
      }

      return requestPlugin;
    }).chain((response) => {
      if (connectionTimer) {
        connectionTimer.stop();
      }
      if (stallTimer) {
        stallTimer.stop();
      }
      if (response.timeMs == undefined) {
        response.timeMs = Date.now() - startTimeMs;
      }
      const responseAndGotProgress = {
        response: response,
        gotProgress: gotProgress,
      };
      if (!headersReceivedCalled) {
        // The plugin did not call headersReceived, perhaps because it is not
        // able to track that information. So, fire the event manually.
        if (this.onHeadersReceived_) {
          this.onHeadersReceived_(response.headers, request, type);
        }
      }

      return responseAndGotProgress;
    }, (error) => {
      if (connectionTimer) {
        connectionTimer.stop();
      }
      if (stallTimer) {
        stallTimer.stop();
      }
      if (this.onDownloadFailed_) {
        let shakaError = null;
        let httpResponseCode = 0;
        if (error instanceof shaka.util.Error) {
          shakaError = error;
          if (error.code == shaka.util.Error.Code.BAD_HTTP_STATUS) {
            httpResponseCode = /** @type {number} */ (error.data[1]);
          }
        }
        this.onDownloadFailed_(request, shakaError, httpResponseCode, aborted);
      }
      if (this.destroyed_) {
        return shaka.util.AbortableOperation.aborted();
      }

      if (aborted) {
        // It is necessary to change the error code to the correct one because
        // otherwise the retry logic would not work.
        error = new shaka.util.Error(
            shaka.util.Error.Severity.RECOVERABLE,
            shaka.util.Error.Category.NETWORK,
            shaka.util.Error.Code.TIMEOUT,
            request.uris[index], type);
      }

      if (error instanceof shaka.util.Error) {
        if (error.code == shaka.util.Error.Code.OPERATION_ABORTED) {
          // Don't change anything if the operation was aborted.
          throw error;
        } else if (error.code == shaka.util.Error.Code.ATTEMPTS_EXHAUSTED) {
          goog.asserts.assert(lastError, 'Should have last error');
          throw lastError;
        }

        if (error.severity == shaka.util.Error.Severity.RECOVERABLE) {
          const event = new shaka.util.FakeEvent('retry', {'error': error});
          this.dispatchEvent(event);

          // Move to the next URI.
          index = (index + 1) % request.uris.length;
          return this.send_(
              type, request, backoff, index, error, numBytesRemainingObj);
        }
      }

      // The error was not recoverable, so do not try again.
      throw error;
    });

    return sendOperation;
  }

  /**
   * @param {shaka.net.NetworkingEngine.RequestType} type
   * @param {shaka.net.NetworkingEngine.ResponseAndGotProgress}
   *        responseAndGotProgress
   * @return {!shaka.extern.IAbortableOperation.<
   *               shaka.net.NetworkingEngine.ResponseAndGotProgress>}
   * @private
   */
  filterResponse_(type, responseAndGotProgress) {
    let filterOperation = shaka.util.AbortableOperation.completed(undefined);
    for (const responseFilter of this.responseFilters_) {
      // Response filters are run sequentially.
      filterOperation = filterOperation.chain(() => {
        const resp = responseAndGotProgress.response;
        if (resp.data) {
          // TODO: See TODO in filterRequest_.
          resp.data = shaka.util.BufferUtils.toArrayBuffer(resp.data);
        }
        return responseFilter(type, resp);
      });
    }
    // If successful, return the filtered response with whether it got
    // progress.
    return filterOperation.chain(() => {
      return responseAndGotProgress;
    }, (e) => {
      // Catch any errors thrown by request filters, and substitute
      // them with a Shaka-native error.

      // The error is assumed to be critical if the original wasn't a Shaka
      // error.
      let severity = shaka.util.Error.Severity.CRITICAL;
      if (e instanceof shaka.util.Error) {
        if (e.code == shaka.util.Error.Code.OPERATION_ABORTED) {
          // Don't change anything if the operation was aborted.
          throw e;
        }

        severity = e.severity;
      }

      throw new shaka.util.Error(
          severity,
          shaka.util.Error.Category.NETWORK,
          shaka.util.Error.Code.RESPONSE_FILTER_ERROR, e);
    });
  }

  /**
   * This is here only for testability.  We can't mock location in our tests on
   * all browsers, so instead we mock this.
   *
   * @return {string} The value of location.protocol.
   * @private
   */
  static getLocationProtocol_() {
    return location.protocol;
  }
};

/**
 * A wrapper class for the number of bytes remaining to be downloaded for the
 * request.
 * Instead of using PendingRequest directly, this class is needed to be sent to
 * plugin as a parameter, and a Promise is returned, before PendingRequest is
 * created.
 *
 * @export
 */
shaka.net.NetworkingEngine.NumBytesRemainingClass = class {
  /**
   * Constructor
   */
  constructor() {
    /** @private {number} */
    this.bytesToLoad_ = 0;
  }

  /**
   * @param {number} bytesToLoad
   */
  setBytes(bytesToLoad) {
    this.bytesToLoad_ = bytesToLoad;
  }

  /**
   * @return {number}
   */
  getBytes() {
    return this.bytesToLoad_;
  }
};

/**
 * A pending network request. This can track the current progress of the
 * download, and allows the request to be aborted if the network is slow.
 *
 * @implements {shaka.extern.IAbortableOperation.<shaka.extern.Response>}
 * @extends {shaka.util.AbortableOperation}
 * @export
 */
shaka.net.NetworkingEngine.PendingRequest =
class extends shaka.util.AbortableOperation {
  /**
   * @param {!Promise} promise
   *   A Promise which represents the underlying operation.  It is resolved
   *   when the operation is complete, and rejected if the operation fails or
   *   is aborted.  Aborted operations should be rejected with a
   *   shaka.util.Error object using the error code OPERATION_ABORTED.
   * @param {function():!Promise} onAbort
   *   Will be called by this object to abort the underlying operation.  This
   *   is not cancelation, and will not necessarily result in any work being
   *   undone.  abort() should return a Promise which is resolved when the
   *   underlying operation has been aborted.  The returned Promise should
   *   never be rejected.
   * @param {shaka.net.NetworkingEngine.NumBytesRemainingClass}
   *   numBytesRemainingObj
   */
  constructor(promise, onAbort, numBytesRemainingObj) {
    super(promise, onAbort);

    /** @private {shaka.net.NetworkingEngine.NumBytesRemainingClass} */
    this.bytesRemaining_ = numBytesRemainingObj;
  }

  /**
   * @return {number}
   */
  getBytesRemaining() {
    return this.bytesRemaining_.getBytes();
  }
};

/**
 * Request types.  Allows a filter to decide which requests to read/alter.
 *
 * @enum {number}
 * @export
 */
shaka.net.NetworkingEngine.RequestType = {
  'MANIFEST': 0,
  'SEGMENT': 1,
  'LICENSE': 2,
  'APP': 3,
  'TIMING': 4,
  'SERVER_CERTIFICATE': 5,
};


/**
 * Priority level for network scheme plugins.
 * If multiple plugins are provided for the same scheme, only the
 * highest-priority one is used.
 *
 * @enum {number}
 * @export
 */
shaka.net.NetworkingEngine.PluginPriority = {
  'FALLBACK': 1,
  'PREFERRED': 2,
  'APPLICATION': 3,
};


/**
 * @typedef {{
 *   plugin: shaka.extern.SchemePlugin,
 *   priority: number,
 *   progressSupport: boolean
 * }}
 * @property {shaka.extern.SchemePlugin} plugin
 *   The associated plugin.
 * @property {number} priority
 *   The plugin's priority.
 * @property {boolean} progressSupport
 *   The plugin's supports progress events
 */
shaka.net.NetworkingEngine.SchemeObject;


/**
 * Contains the scheme plugins.
 *
 * @private {!Object.<string, shaka.net.NetworkingEngine.SchemeObject>}
 */
shaka.net.NetworkingEngine.schemes_ = {};

/**
 * @typedef {{
 *   response: shaka.extern.Response,
 *   gotProgress: boolean
 * }}
 *
 * @description
 * Defines a response wrapper object, including the response object and whether
 * progress event is fired by the scheme plugin.
 *
 * @property {shaka.extern.Response} response
 * @property {boolean} gotProgress
 * @private
 */
shaka.net.NetworkingEngine.ResponseAndGotProgress;


/**
 * @typedef {function(
 *    !Object.<string, string>,
 *    !shaka.extern.Request,
 *    !shaka.net.NetworkingEngine.RequestType)}
 *
 * @description
 * A callback function that passes the shaka.extern.HeadersReceived along to
 * the player, plus some extra data.
 * @export
 */
shaka.net.NetworkingEngine.OnHeadersReceived;


/**
 * @typedef {function(
 *    !shaka.extern.Request,
 *    ?shaka.util.Error,
 *    number,
 *    boolean)}
 *
 * @description
 * A callback function that notifies the player when a download fails, for any
 * reason (e.g. even if the download was aborted).
 * @export
 */
shaka.net.NetworkingEngine.OnDownloadFailed;
