import { BN } from "../types";
import { parseFixed } from "@uma/common";
import moment from "moment";
import type { Logger } from "winston";
import { NetworkerInterface } from "./Networker";
import { PriceFeedInterface } from "./PriceFeedInterface";
import Web3 from "web3";

export class StatisticsNetherlandsPriceFeed extends PriceFeedInterface {
  private readonly uuid: string;
  private readonly convertPriceFeedDecimals: (number: number | string | BN) => BN;
  private priceHistory: { date: number; price: BN }[];
  private currentPrice: BN | null = null;
  private lastUpdateTime: number | null = null;

  /**
   * @notice Constructs the StatisticsNetherlandsPriceFeed.
   * @param {Object} logger Winston module used to send logs.
   * @param {String} symbolString String used in query to fetch symbolString data, i.e. "URTH"
   * @param {Integer} lookback How far in the past the historical prices will be available using getHistoricalPrice.
   * @param {Object} networker Used to send the API requests.
   * @param {Function} getTime Returns the current time.
   * @param {Number} priceFeedDecimals Number of priceFeedDecimals to use to convert price to wei.
   * @param {Integer} minTimeBetweenUpdates Min number of seconds between updates. If update() is called again before
   *      this number of seconds has passed, it will be a no-op.
   */
  constructor(
    private readonly logger: Logger,
    private readonly symbolString: string,
    private readonly lookback: number, // lookback should ideally be 4 days to account for NYSE weekends and holidays
    private readonly networker: NetworkerInterface,
    private readonly getTime: () => Promise<number>,
    private readonly priceFeedDecimals = 18,
    private readonly minTimeBetweenUpdates = 900 // 15 mins is a reasonable default since this API uses an interval of 15min
  ) {
    super();

    this.uuid = `StatisticsNetherlands-${symbolString}`;

    this.priceHistory = [];

    this.convertPriceFeedDecimals = (number) => {
      return Web3.utils.toBN(
        parseFixed(number.toString().substring(0, priceFeedDecimals), priceFeedDecimals).toString()
      );
    };
  }
  public async update(): Promise<void> {
    const currentTime = await this.getTime();

    // Return early if the last call was too recent.
    if (this.lastUpdateTime !== null && this.lastUpdateTime + this.minTimeBetweenUpdates > currentTime) {
      this.logger.debug({
        at: "StatisticsNetherlandsApiPriceFeed",
        message: "Update skipped because the last one was too recent",
        currentTime: currentTime,
        lastUpdateTimestamp: this.lastUpdateTime,
        timeRemainingUntilUpdate: this.lastUpdateTime + this.minTimeBetweenUpdates - currentTime,
      });
      return;
    }

    const startLookbackWindow = currentTime - this.lookback;
    // dataFetchStart gives an "early bound" to our data
    const dataFetchStartDateString = this._secondToDate(startLookbackWindow);
    const formattedStartDateString = this.formatDate(dataFetchStartDateString);

    this.logger.debug({
      at: "StatisticsNetherlandsApiPriceFeed",
      message: "Updating StatisticsNetherlandsApiPriceFeed",
      currentTime: currentTime,
      lastUpdateTimestamp: this.lastUpdateTime,
    });

    // 1. Construct URL.
    // See https://cran.r-project.org/web/packages/cbsodataR/cbsodataR.pdf
    // https://opendata.cbs.nl/ODataApi/odata/83906ENG/UntypedDataSet?$filter=Periods ge '2023MM01'
    const url =
      `https://opendata.cbs.nl/ODataApi/odata/83906ENG/UntypedDataSet` +
      `?$filter=Periods ge '` +
      `${formattedStartDateString}'`;

    // 2. Send request.
    const historyResponse = await this.networker.getJson(url);

    // Sample Response
    // {
    //   "odata.metadata": "https://opendata.cbs.nl/ODataApi/OData/83906ENG/$metadata#Cbs.OData.WebAPI.UntypedDataSet",
    //     "value": [
    //       {
    //         "ID": 476,
    //         "Periods": "2023MM01",
    //         "PriceIndexOfExistingOwnHomes_1": "   183.3",
    //         "ChangesComparedToThePreviousPeriod_2": "     1.5",
    //         "ChangesComparedToThePreviousYear_3": "     1.1",
    //         "NumberOfSoldDwellings_4": "   13126",
    //         "ChangesComparedToThePreviousPeriod_5": "   -38.5",
    //         "ChangesComparedToThePreviousYear_6": "    -6.6",
    //         "AveragePurchasePrice_7": "  424681",
    //         "TotalValuePurchasePrices_8": "    5574"
    //       },
    //       {
    //         "ID": 477,
    //         "Periods": "2023MM02",
    //         "PriceIndexOfExistingOwnHomes_1": "   180.6",
    //         "ChangesComparedToThePreviousPeriod_2": "    -1.5",
    //         "ChangesComparedToThePreviousYear_3": "    -0.8",
    //         "NumberOfSoldDwellings_4": "   11858",
    //         "ChangesComparedToThePreviousPeriod_5": "    -9.7",
    //         "ChangesComparedToThePreviousYear_6": "   -15.5",
    //         "AveragePurchasePrice_7": "  410189",
    //         "TotalValuePurchasePrices_8": "    4864"
    //       }
    //     ]
    // }

    // 3. Check responses.
    if (!historyResponse?.value || historyResponse.value.length === 0) {
      throw new Error(`🚨Could not parse price result from url ${url}: ${JSON.stringify(historyResponse)}`);
    }

    // 4. Parse results.
    // historyResponse.value
    const newHistoricalPricePeriods = historyResponse.value.map((dailyData: any) => {
      return {
        date: this.convertFormattedDateToTimestamp(dailyData.Periods),
        price: this.convertPriceFeedDecimals(dailyData.PriceIndexOfExistingOwnHomes_1.trim()),
        // price: dailyData.PriceIndexOfExistingOwnHomes_1.trim(),
      };
    });

    // 5. Store results.
    this.currentPrice = newHistoricalPricePeriods[newHistoricalPricePeriods.length - 1].price;
    this.priceHistory = newHistoricalPricePeriods;
    this.lastUpdateTime = currentTime;

    // NLHPI updates on the 22nd of every month at 02:00:00
    // TODO: Account for edge case, when 22nd falls on a weekend, in that scenario StatisticsNetherlands would publish data on next working day.
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
    console.log("first price:", firstPrice);

    // If there are no valid price periods, return null.
    if (!firstPrice) {
      throw new Error(`${this.uuid}: no valid price periods`);
    }

    // If the time is before the first piece of data in the set, return null because
    // the price is before the lookback window.
    if (time < firstPrice.date) {
      throw new Error(`${this.uuid}: time ${time} is before firstPricePeriod.closeTime`);
    }

    // historicalPricePeriods are ordered from oldest to newest.
    // This finds the first index in pricePeriod whose time is after the provided time.
    const matchedIndex = this.priceHistory.findIndex((pricePeriod) => {
      return time < pricePeriod.date;
    });

    // Then we get the previous element to matchedIndex. Since that would be the last closing price for us.
    let match = undefined;
    if (matchedIndex > 0) {
      match = this.priceHistory[matchedIndex - 1];
    }

    // If there is no match, that means that the time was past the last data point.
    // In this case, the best match for this price is the current price.
    let returnPrice;
    if (match === undefined) {
      if (this.currentPrice === null) throw new Error(`${this.uuid}: currentPrice is null`);
      returnPrice = this.currentPrice;
      if (verbose) {
        console.group(`\n(${this.symbolString}) No price available @ ${time}`);
        console.log(
          `- ✅ Time is later than earliest historical time, fetching current price: ${Web3.utils.fromWei(
            returnPrice.toString()
          )}`
        );
        console.groupEnd();
      }
      return returnPrice;
    }

    returnPrice = match.price;
    if (verbose) {
      console.group(`\n(${this.symbolString}) Historical price @ ${match.date}`);
      console.log(`- ✅ Close Price:${Web3.utils.fromWei(returnPrice.toString())}`);
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

  private _secondToDate(inputSecond: number): string {
    return moment.unix(inputSecond).format("YYYY-MM-DD");
  }

  private _dateTimeToSecond(inputDateTime: string, endOfDay = false) {
    if (endOfDay) {
      return moment(inputDateTime, "YYYY-MM-DD HH:mm:ss").endOf("day").unix();
    } else {
      return moment(inputDateTime, "YYYY-MM-DD HH:mm:ss").unix();
    }
  }

  private convertFormattedDateToTimestamp(formattedDate: string) {
    const year = formattedDate.slice(0, 4);
    const monthString = formattedDate.slice(6, 8);
    const date = new Date(Date.UTC(Number(year), Number(monthString), 22, 2, 0, 0));
    return moment(date, "YYYY-MM-DD HH:mm:ss").unix();
  }

  private incrementMonthAsString(month: number): string {
    let incrementMonth: number;

    if (month >= 1 && month <= 11) {
      // If the month is between January (1) and November (11), simply increment by 1
      incrementMonth = month + 1;
    } else if (month === 12) {
      // If the month is December (12), set the month to January (1)
      incrementMonth = 1;
    } else {
      throw new Error("Invalid month value");
    }

    const incrementMonthString = incrementMonth.toString().padStart(2, "0");
    return incrementMonthString;
  }

  private formatDate(startDate: string) {
    const date = new Date(startDate);
    const year = date.getFullYear().toString();
    const month = ("0" + (date.getMonth() + 1)).slice(-2); // add leading zero if month is less than 10
    return year + "MM" + month;
  }
}
