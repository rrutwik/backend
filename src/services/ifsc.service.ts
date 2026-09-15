import { Service } from 'typedi';
import { FilterQuery } from 'mongoose';
import { IFSCCode } from '@/interfaces/ifsc_code.interface';
import { IFSCCodeModel } from '@/models/data/ifsc_code.model';
import { cache } from '@/cache';

export interface IFSCSearchParams {
  q?: string;
  ifsc?: string;
  bank?: string;
  bank_code?: string;
  branch?: string;
  city?: string;
  district?: string;
  state?: string;
  limit?: number;
  offset?: number;
}

@Service()
export class IFSCService {
  public async getByIFSC(ifsc: string) {
    if (!ifsc) return null;
    return IFSCCodeModel.findOne({ ifsc: ifsc.toUpperCase() });
  }

  public async search(params: IFSCSearchParams) {
    const {
      q,
      bank,
      bank_code,
      branch,
      city,
      district,
      state,
      limit = 20,
      offset = 0,
    } = params;

    const filter: any = {};
    let usesTextSearch = false; // <-- track this

    if (q && q.trim()) {
      const cleaned = this.sanitizeTextQuery(q.trim());

      if (/^[A-Z0-9]{4}0[A-Z0-9]{6}$/i.test(q)) {
        filter.ifsc = { $regex: `^${q.trim()}`, $options: 'i' };
      } else {
        filter.$text = { $search: cleaned || q.trim() };
        usesTextSearch = true; // <-- only true here
      }
    }

    if (bank) filter.bank = bank;
    if (bank_code) filter.bank_code = bank_code;
    if (branch) filter.branch = branch;
    if (city) filter.city = city;
    if (district) filter.district = district;
    if (state) filter.state = state;

    const cacheKey = `ifsc_search_${JSON.stringify(filter)}`;
    let total = await cache.get(cacheKey);
    if (!total) {
      total = await IFSCCodeModel.countDocuments(filter);
      await cache.set(cacheKey, total, 60 * 60 * 24 * 7);
    }
    total = parseInt(total as string);

    const records = await IFSCCodeModel.find(filter)
      .skip(offset)
      .limit(limit)
      .sort(usesTextSearch ? { score: { $meta: 'textScore' } } : { bank: 1, city: 1, branch: 1 })
      .select({
        _id: 0,
        ifsc: 1,
        bank: 1,
        bank_code: 1,
        branch: 1,
        city: 1,
        district: 1,
        state: 1,
        address: 1,
        contact: 1,
        micr: 1,
        swift: 1,
        iso3166: 1,
        imps: 1,
        neft: 1,
        rtgs: 1,
        upi: 1,
        type: 1,
        ...(usesTextSearch ? { score: { $meta: 'textScore' } } : {}),
      });

    return { records, total, limit, offset };
  }


  // Remove generic noise terms so queries like "SBI Bank" behave like "SBI"
  private sanitizeTextQuery(input: string) {
    const noise = new Set([
      'bank', 'banks', 'ltd', 'limited', 'cooperative', 'co-operative', 'the',
      'of', 'and'
    ]);
    const parts = input
      .split(/\s+/)
      .map(s => s.trim())
      .filter(Boolean)
      .filter(tok => !noise.has(tok.toLowerCase()));
    return parts.join(' ');
  }

  private getDistinctBanksForCacheKey(filter: FilterQuery<IFSCCode>) {
    const cacheKey = `distinctBanks_${JSON.stringify(filter)}`;
    return cacheKey;
  }

  public async distinctBanks(city?: string) {
    const filter: FilterQuery<IFSCCode> = {};
    if (city) filter.city = new RegExp(this.escapeRegex(city), 'i');
    const cacheKey = this.getDistinctBanksForCacheKey(filter);
    let cached = await cache.get(cacheKey);
    if (cached) return cached;
    const result = await IFSCCodeModel.distinct('bank', filter);
    await cache.set(cacheKey, result, 60 * 60 * 24 * 7);
    return result;
  }

  private getDistinctCitiesForCacheKey(filter: FilterQuery<IFSCCode>) {
    const cacheKey = `distinctCities_${JSON.stringify(filter)}`;
    return cacheKey;
  }

  public async distinctCities(bank?: string) {
    const filter: FilterQuery<IFSCCode> = {};
    if (bank) filter.bank = new RegExp(this.escapeRegex(bank), 'i');
    const cacheKey = this.getDistinctCitiesForCacheKey(filter);
    const cached = await cache.get(cacheKey);
    if (cached) return cached;
    const result = await IFSCCodeModel.distinct('city', filter);
    await cache.set(cacheKey, result, 60 * 60 * 24 * 7);
    return result;
  }

  public async distinctBranches(bank?: string, city?: string) {
    const filter: FilterQuery<IFSCCode> = {};
    if (bank) filter.bank = new RegExp(this.escapeRegex(bank), 'i');
    if (city) filter.city = new RegExp(this.escapeRegex(city), 'i');
    const cacheKey = this.getDistinctBranchesForCacheKey(filter);
    const cached = await cache.get(cacheKey);
    if (cached) return cached;
    const result = await IFSCCodeModel.distinct('branch', filter);
    await cache.set(cacheKey, result, 60 * 60 * 24 * 7);
    return result;
  }

  private getDistinctBranchesForCacheKey(filter: FilterQuery<IFSCCode>) {
    const cacheKey = `distinctBranches_${JSON.stringify(filter)}`;
    return cacheKey;
  }

  private escapeRegex(input: string) {
    return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}
