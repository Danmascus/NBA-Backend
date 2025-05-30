const db = require('../config/db.config');
const Bet = require('../models/bet.model');
const MatchRepository = require('./match.repository'); // Adjust path as needed
const UserRepository = require('./user.repository');
const APIError = require("../errors/api.error"); // Adjust path as needed

const mapRowToBet = (row) => {
    return {
        id: row.id,
        user_id: row.user_id,
        game_id: row.game_id,
        team_id: row.team_id,
        odds_bet_with: row.odds_bet_with,
        currency_bet: row.currency_bet,
        state: row.state,
        created: row.created
    };
}

class BetRepository {
    constructor() {
        this.matchRepository = MatchRepository;
        this.userRepository = UserRepository;
    }

    async placeBets(userId, betsArray) {
        const user = await this.userRepository.findById(userId);
        if (!user) throw new APIError(404, 'User not found');
        const userCurrency = Number(user.currency);

        const totalBetAmount = betsArray.reduce((sum, bet) => sum + Number(bet.betAmount), 0);

        if (userCurrency < totalBetAmount) {
            throw new APIError(400, 'Insufficient funds for the total bet amount');
        }

        if (totalBetAmount <= 0) {
            throw new APIError(400, 'Bet amount must be greater than 0');
        }

        const placedBets = [];
        await db.query('BEGIN');
        try {
            for (const bet of betsArray) {
                const placedBet = await this.placeSingleBet(userId, bet);
                placedBets.push(placedBet);
            }
            await db.query('COMMIT');
            return placedBets;
        } catch (error) {
            await db.query('ROLLBACK');
            throw new APIError(error.statusCode || 500, 'Error placing bets: ' + error.message);
        }
    }

    async placeSingleBet(userId, {gameId, teamId, betAmount, odds}) {
        const user = await this.userRepository.findById(userId);
        const currencyAsNumber = Number(user.currency);
        const betAmountAsNumber = Number(betAmount);

        const match = await this.matchRepository.findById(gameId);

        const TOLERANCE = 0.001;

        const isOddsMatch = (odds1, odds2) => {
            return Math.abs(odds1 - odds2) < TOLERANCE;
        };

        if (!match || (odds && !isOddsMatch(match.teamOneOdds, odds) && !isOddsMatch(match.teamTwoOdds, odds))) {
            throw new APIError(400, 'Match not available or odds mismatch');
        }

        const newBet = new Bet({
            game_id: gameId,
            user_id: userId,
            team_id: teamId,
            odds_bet_with: odds,
            currency_bet: betAmount,
            state: 'PENDING'
        });

        await this.userRepository.updateCurrency(userId, currencyAsNumber - betAmountAsNumber);

        const result = await db.query(
            'INSERT INTO bets (game_id, user_id, team_id, odds_bet_with, currency_bet, state) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
            [newBet.game_id, newBet.user_id, newBet.team_id, newBet.odds_bet_with, newBet.currency_bet, newBet.state]
        );

        return result.rows[0];
    }

    async findBetsByUser(userId, {state = null, page = 0, pageSize = 20, beforeDate, afterDate}) {
        try {
            const offset = page * pageSize;
            let params = [userId];
            let query = 'SELECT * FROM bets WHERE user_id = $1';

            if (state) {
                query += ' AND state = $2';
                params.push(state);
            }

            query += ' ORDER BY created DESC LIMIT $' + (params.length + 1) + ' OFFSET $' + (params.length + 2);

            params.push(pageSize, offset);

            const results = await db.query(query, params);

            const resultsMappedToRow = results.rows.map(mapRowToBet);

            const finalResponse = []

            for (const bet of resultsMappedToRow) {
                const match = await this.matchRepository.findById(bet.game_id);

                if ((beforeDate && new Date(match.matchDate) > new Date(beforeDate)) || (afterDate && new Date(match.matchDate) < new Date(afterDate))) {
                    continue;
                }

                finalResponse.push({
                    id: bet.id,
                    teamOne: match.teamOne,
                    teamOneId: match.teamOneId,
                    teamOneOdds: match.teamOneOdds,
                    teamTwo: match.teamTwo,
                    teamTwoId: match.teamTwoId,
                    teamTwoOdds: match.teamTwoOdds,
                    matchDate: match.matchDate,
                    betAmount: bet.currency_bet,
                    betTeamId: bet.team_id,
                    state: bet.state
                })
            }

            return finalResponse;
        } catch (error) {
            throw new APIError(500, 'Error fetching bets by user: ' + error.message);
        }
    }

    async findBetsByState(state) {
        try {
            const result = await db.query('SELECT * FROM bets WHERE state = $1', [state]);
            return result.rows.map(mapRowToBet);
        } catch (error) {
            throw new APIError(500, 'Error fetching bets by state: ' + error.message);
        }
    }

    async updateBetState(betId, state) {
        try {
            const result = await db.query('UPDATE bets SET state = $1 WHERE id = $2 RETURNING *', [state, betId]);
            return result.rows && result.rows.length ? mapRowToBet(result.rows[0]) : null;
        } catch (error) {
            throw new APIError(500, 'Error updating bet state: ' + error.message);
        }
    }
}

module.exports = new BetRepository();
