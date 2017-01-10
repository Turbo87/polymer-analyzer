/**
 * @license
 * Copyright (c) 2016 The Polymer Project Authors. All rights reserved.
 * This code may only be used under the BSD style license found at
 * http://polymer.github.io/LICENSE.txt
 * The complete set of authors may be found at
 * http://polymer.github.io/AUTHORS.txt
 * The complete set of contributors may be found at
 * http://polymer.github.io/CONTRIBUTORS.txt
 * Code distributed by Google as part of the polymer project is also
 * subject to an additional IP rights grant found at
 * http://polymer.github.io/PATENTS.txt
 */

import {Deferred} from '../utils';

export class AsyncCyclicTransitivePromiseAll<Key> {
  private _deferreds = new Map<Key, Deferred<Key[]>>();

  /**
   * Call when a key has been processed, with the deps of the key.
   */
  resolve(key: Key, deps: Iterable<Key>) {
    this._getDeferredFor(key).resolve(Array.from(deps));
  }

  /**
   * Returns a promise when the given key and all of its transitive dependencies
   * have been resolved.
   *
   * Not bothered by cycles in the dependency graph.
   */
  async promiseAllTransitive(key: Key): Promise<void> {
    await this._transitiveAwait(key, new Set<Key>());
  }

  private async _transitiveAwait(key: Key, visited: Set<Key>) {
    if (visited.has(key)) {
      return;
    }
    visited.add(key);
    const deps = await this._getDeferredFor(key).promise;
    for (const dep of deps) {
      await this._transitiveAwait(dep, visited);
    }
  }

  private _getDeferredFor(key: Key) {
    const deferred = this._deferreds.get(key) || new Deferred<Key[]>();
    this._deferreds.set(key, deferred);
    return deferred;
  }
}
