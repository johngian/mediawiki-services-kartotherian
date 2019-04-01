'use strict';

let Promise = require('bluebird'),
    undefinedPromise = Promise.resolve(undefined);

/**
 * Yields { idx: (index) } objects with sequential index, where idxFrom <= index < idxBefore
 * @param {int} idxFrom
 * @param {int} idxBefore
 * @returns {Function}
 */
module.exports.getSimpleIterator = function(idxFrom, idxBefore) {
    let idx = idxFrom;
    return () => {
        let result = undefined;
        if (idx < idxBefore) {
            result = {idx: idx++};
        }
        return Promise.resolve(result);
    }
};

/**
 * Given an iterator that yields {idx:index} values, merges sequential values of indexes,
 * and yields ranges as [idxFrom, idxBefore] arrays
 */
module.exports.sequenceToRangesIterator = function(iterator) {
    let firstIdx, lastIdx, doneValue;

    let getNextValAsync = () => doneValue || iterator().then(iterValue => {
        let idx = iterValue === undefined ? undefined : iterValue.idx;
        if (firstIdx === undefined) {
            if (idx === undefined) {
                // empty result
                doneValue = undefinedPromise;
                return undefined;
            }
            firstIdx = lastIdx = idx;
            return getNextValAsync();
        } else if (idx === lastIdx + 1) {
            lastIdx = idx;
            return getNextValAsync();
        }

        let res = [firstIdx, lastIdx + 1];
        firstIdx = lastIdx = idx;
        if (idx === undefined) {
            doneValue = undefinedPromise;
        }
        return res;
    });
    return getNextValAsync;
};


/**
 * Given an iterator of {idx:index} values, yield the missing values within the given range
 */
module.exports.invertIterator = function(iterator, idxFrom, idxBefore) {
    let nextValP, doneValue,
        idxNext = idxFrom;

    let getNextValAsync = () => {
        if (!nextValP) {
            nextValP = iterator();
        }
        return doneValue || nextValP.then(iterValue => {
            let untilIdx = idxBefore;
            if (iterValue !== undefined && iterValue.idx < idxBefore) {
                // iterValue exists within the range - yield all indexes before it
                untilIdx = iterValue.idx;
            }
            if (idxNext < untilIdx) {
                // yield next pending index
                return {idx: idxNext++};
            } else if (iterValue === undefined || iterValue.idx >= idxBefore) {
                // no more iterValue, or it's outside of the range - we are done, attempt to cancel iteration
                doneValue = undefinedPromise;
                return undefined;
            } else {
                if (idxNext === iterValue.idx) {
                    // no more values can be iterated for the current range, get next
                    idxNext++;
                    nextValP = iterator();
                } else if (iterValue.idx < idxNext) {
                    // received value less than idxFrom, skip it
                    nextValP = iterator();
                }
                return getNextValAsync();
            }
        });
    };
    return getNextValAsync;
};
