import { BN } from "../types";
import { parseFixed } from "@uma/common";
import moment from "moment";
import type { Logger } from "winston";
import { NetworkerInterface } from "./Networker";
import { PriceFeedInterface } from "./PriceFeedInterface";
import Web3 from "web3";

export class TweleveDataApiPriceFeed extends PriceFeedInterface {
  private readonly uuid: string;
  private readonly convertPriceFeedDecimals: (number: number | string | BN) => BN;
  private priceHistory: { date: number; closePrice: BN }[];
  private currentPrice: BN | null = null;
  private lastUpdateTime: number | null = null;

  /**
   * @notice Constructs the TweleveDataApiPriceFeed.
   * @param {Object} logger Winston module used to send logs.
   * @param {String} index String used in query to fetch index data, i.e. "URTH"
   * @param {String} apiKey apiKey for TweleveData api
   * @param {Integer} lookback How far in the past the historical prices will be available using getHistoricalPrice.
   * @param {Object} networker Used to send the API requests.
   * @param {Function} getTime Returns the current time.
   * @param {Number} priceFeedDecimals Number of priceFeedDecimals to use to convert price to wei.
   * @param {Integer} minTimeBetweenUpdates Min number of seconds between updates. If update() is called again before
   *      this number of seconds has passed, it will be a no-op.
   */
  constructor(
    private readonly logger: Logger,
    private readonly index: String,
    private readonly apiKey: string,
    private readonly lookback: number,
    private readonly networker: NetworkerInterface,
    private readonly getTime: () => Promise<number>,
    private readonly priceFeedDecimals = 18,
    private readonly minTimeBetweenUpdates = 43200 // 12 hours is a reasonable default since this pricefeed returns daily granularity at best.
  ) {
    super();

    this.uuid = `TweleveData-${index}`;

    this.priceHistory = [];

    this.convertPriceFeedDecimals = (number) => {
      // Converts price result to wei
      // returns price conversion to correct decimals as a big number.
      // Note: Must ensure that `number` has no more decimal places than `priceFeedDecimals`.
      return Web3.utils.toBN(parseFixed(number.toString().substring(0, priceFeedDecimals), priceFeedDecimals).toString());
    };
  }
  // Updates the internal state of the price feed. Should pull in any async data so the get*Price methods can be called.
  // Will use the optional ancillary data parameter to customize what kind of data get*Price returns.
  // Note: derived classes *must* override this method.
  // Note: Eventually `update` will be removed in favor of folding its logic into `getCurrentPrice`.
  public async update(ancillaryData?: string): Promise<void> {
    const currentTime = await this.getTime();

    // Return early if the last call was too recent.
    if (this.lastUpdateTime !== null && this.lastUpdateTime + this.minTimeBetweenUpdates > currentTime) {
      this.logger.debug({
        at: "TweleveDataApiPriceFeed",
        message: "Update skipped because the last one was too recent",
        currentTime: currentTime,
        lastUpdateTimestamp: this.lastUpdateTime,
        timeRemainingUntilUpdate: this.lastUpdateTime + this.minTimeBetweenUpdates - currentTime,
      });
      return;
    }

    this.logger.debug({
      at: "TweleveDataApiPriceFeed",
      message: "Updating TweleveDataApiPriceFeed",
      currentTime: currentTime,
      lastUpdateTimestamp: this.lastUpdateTime,
    });

    const startLookbackWindow = currentTime - this.lookback;
    const startDateString = this._secondToDateTime(startLookbackWindow);
    const endDateString = this._secondToDateTime(currentTime);

    console.log("DEBUG-URTH: Logging here too");

    // 1. Construct URL.
    // See https://twelvedata.com/docs#getting-started
    // Timeseries API with date range, results are ordered in time descending
    // https://api.twelvedata.com/time_series?apikey=API_KEY=1h&symbol=SYMBOL&start_date=START_DATE&end_date=END_DATE;
    const url = `https://api.twelvedata.com/time_series?apikey=8c28e2ab6088439e92a60426194469af&interval=1h&symbol=URTH&start_date=2023-02-10 09:30:00&end_date=2023-02-13 20:00:00`;

    console.log("DEBUG-TWELEVE: url", url);

    // 2. Send request.
    const historyResponse = await this.networker.getJson(url);
    console.log("DEBUG-TWELVEDATA: ", historyResponse);

    // Sample Response
    // {
    //   "meta": {
    //   "symbol": "URTH",
    //   "interval": "1h",
    //   "currency": "USD",
    //   "exchange_timezone": "America/New_York",
    //   "exchange": "NYSE",
    //   "mic_code": "ARCX",
    //   "type": "ETF"
    //   },
    //   "values": [
    //   {
    //   "datetime": "2023-02-10 15:30:00",
    //   "open": "116.67000",
    //   "high": "116.93000",
    //   "low": "116.67000",
    //   "close": "116.84000",
    //   "volume": "19274"
    //   },
    //   {
    //   "datetime": "2023-02-10 14:30:00",
    //   "open": "116.45500",
    //   "high": "116.78000",
    //   "low": "116.45000",
    //   "close": "116.64000",
    //   "volume": "145608"
    //   },
    //   .
    //   .
    //   ],
    //   "status": "ok"
    //   }

    // 3. Check responses.
    if (!historyResponse?.values || historyResponse.values.length === 0) {
      throw new Error(`🚨Could not parse price result from url ${url}: ${JSON.stringify(historyResponse)}`);
    }

    // 4. Parse results.
    // historyResponse.values
    const newHistoricalPricePeriods =
      historyResponse.values
        .map((dailyData: any) => ({
          date: dailyData.datetime,
          closePrice: this.convertPriceFeedDecimals(dailyData.close),
        }))

    // 5. Store results.
    this.currentPrice = newHistoricalPricePeriods[newHistoricalPricePeriods.length - 1].closePrice;
    this.priceHistory = newHistoricalPricePeriods;
    this.lastUpdateTime = currentTime;

    console.log("DEBUG-URTH: ", this.currentPrice?.toString());
    console.log("DEBUG-URTH: ", this.priceHistory);

  }


  public getCurrentPrice(): BN | null {
    return this.currentPrice;
  }

  public async getHistoricalPrice(time: number, ancillaryData?: string, verbose?: boolean): Promise<BN | null> {
    if (this.lastUpdateTime === undefined) {
      throw new Error(`${this.uuid}: undefined lastUpdateTime`);
    }

    // Set first price period in `historicalPricePeriods` to first non-null price.
    let firstPrice;
    for (const p in this.priceHistory) {
      if (this.priceHistory[p] && this.priceHistory[p].date) {
        firstPrice = this.priceHistory[p];
        break;
      }
    }

    // If there are no valid price periods, return null.
    if (!firstPrice) {
      throw new Error(`${this.uuid}: no valid price periods`);
    }

    // If the time is before the first piece of data in the set, return null because
    // the price is before the lookback window.
    if (time < firstPrice.date) {
      throw new Error(`${this.uuid}: time ${time} is before firstPricePeriod.openTime`);
    }

    // historicalPricePeriods are ordered from oldest to newest.
    // This finds the first pricePeriod whose closeTime is after the provided time.
    const match = this.priceHistory.find((pricePeriod) => {
      return time < pricePeriod.date;
    });

    // If there is no match, that means that the time was past the last data point.
    // In this case, the best match for this price is the current price.
    let returnPrice;
    if (match === undefined) {
      if (this.currentPrice === null) throw new Error(`${this.uuid}: currentPrice is null`);
      returnPrice = this.currentPrice;
      if (verbose) {
        console.group(`\n(${this.index}) No price available @ ${time}`);
        console.log(
          `- ✅ Time is later than earliest historical time, fetching current price: ${Web3.utils.fromWei(
            returnPrice.toString()
          )}`
        );
        console.groupEnd();
      }
      return returnPrice;
    }

    returnPrice = match.closePrice;
    if (verbose) {
      console.group(`\n(${this.index}) Historical price @ ${match.date}`);
      console.log(`- ✅ Open Price:${Web3.utils.fromWei(returnPrice.toString())}`);
      console.groupEnd();
    }
    return returnPrice;
  }

  public getLastUpdateTime(): number | null {
    return this.lastUpdateTime;
  }

  public getLookback(): number {
    return this.lookback;
  }

  public getPriceFeedDecimals(): number {
    return this.priceFeedDecimals;
  }

  private _secondToDateTime(inputSecond: number) {
    return moment.unix(inputSecond).format("YYYY-MM-DD");
  }
  private _dateTimeToSecond(inputDateTime: string, endOfDay = false) {
    if (endOfDay) {
      return moment(inputDateTime, "YYYY-MM-DD").endOf("day").unix();
    } else {
      return moment(inputDateTime, "YYYY-MM-DD").unix();
    }
  }
}